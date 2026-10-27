package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	proxyapi "github.com/router-for-me/CLIProxyAPI/v7/sdk/api"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	proxyconfig "github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

const (
	bridgePort       = 18317
	bridgeVersion    = "0.1.0"
	maxNativeMessage = 4 * 1024 * 1024
)

type nativeRequest struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Data map[string]any `json:"data,omitempty"`
}

type nativeResponse struct {
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

type bridgeSecrets struct {
	ClientAPIKey  string `json:"clientApiKey"`
	ManagementKey string `json:"managementKey"`
	TextAPIKey    string `json:"textApiKey"`
}

type bridgeRuntime struct {
	dataDir            string
	authDir            string
	configPath         string
	secrets            bridgeSecrets
	ready              chan struct{}
	done               chan struct{}
	readyOnce          sync.Once
	mu                 sync.Mutex
	runErr             error
	textMu             sync.Mutex
	textStarting       bool
	textErr            error
	textFailedAt       time.Time
	networkProxySource string
	modelCatalog       *accountModelCatalog
}

func main() {
	nativeOut := os.Stdout
	os.Stdout = os.Stderr

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bridge, err := newBridgeRuntime()
	if err != nil {
		_ = writeNativeMessage(nativeOut, nativeResponse{OK: false, Error: err.Error()})
		return
	}
	if err = bridge.start(ctx); err != nil {
		_ = writeNativeMessage(nativeOut, nativeResponse{OK: false, Error: err.Error()})
		return
	}

	reader := bufio.NewReader(os.Stdin)
	for {
		request, readErr := readNativeMessage(reader)
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			return
		}
		if readErr != nil {
			_ = writeNativeMessage(nativeOut, nativeResponse{OK: false, Error: readErr.Error()})
			return
		}

		response := bridge.handle(request)
		if err = writeNativeMessage(nativeOut, response); err != nil {
			return
		}
	}
}

func newBridgeRuntime() (*bridgeRuntime, error) {
	dataDir, err := bridgeDataDir()
	if err != nil {
		return nil, err
	}
	authDir := filepath.Join(dataDir, "auths")
	if err = os.MkdirAll(authDir, 0o700); err != nil {
		return nil, fmt.Errorf("create bridge data directory: %w", err)
	}

	secretsPath := filepath.Join(dataDir, "bridge-secrets.json")
	secrets, err := loadOrCreateSecrets(secretsPath)
	if err != nil {
		return nil, err
	}

	configPath := filepath.Join(dataDir, "config.yaml")
	proxyURL, proxySource, err := resolveBridgeProxy(os.Getenv, systemProxyServer)
	if err != nil {
		return nil, err
	}
	if err = writeBridgeConfig(configPath, authDir, secrets, proxyURL); err != nil {
		return nil, err
	}

	return &bridgeRuntime{
		dataDir:            dataDir,
		authDir:            authDir,
		configPath:         configPath,
		secrets:            secrets,
		networkProxySource: proxySource,
		ready:              make(chan struct{}),
		done:               make(chan struct{}),
	}, nil
}

func (b *bridgeRuntime) start(ctx context.Context) error {
	cfg, err := proxyconfig.LoadConfig(b.configPath)
	if err != nil {
		return fmt.Errorf("load bridge configuration: %w", err)
	}

	store := sdkauth.GetTokenStore()
	if setter, ok := store.(interface{ SetBaseDir(string) }); ok {
		setter.SetBaseDir(b.authDir)
	}
	manager := coreauth.NewManager(store, &coreauth.RoundRobinSelector{}, nil)
	b.modelCatalog, err = newAccountModelCatalog(manager, cliproxy.GlobalModelRegistry(), cfg.ProxyURL)
	if err != nil {
		return err
	}
	b.modelCatalog.gatewayKey = b.secrets.ClientAPIKey
	cliproxy.SetGlobalModelRegistryHook(b.modelCatalog)
	service, err := cliproxy.NewBuilder().
		WithConfig(cfg).
		WithConfigPath(b.configPath).
		WithCoreAuthManager(manager).
		WithServerOptions(proxyapi.WithMiddleware(oauthCallbackNotice, b.modelCatalog.restoreForInference)).
		WithHooks(cliproxy.Hooks{
			OnAfterStart: func(*cliproxy.Service) {
				b.readyOnce.Do(func() { close(b.ready) })
			},
		}).
		Build()
	if err != nil {
		return fmt.Errorf("build embedded model bridge: %w", err)
	}

	go func() {
		runErr := service.Run(ctx)
		b.mu.Lock()
		b.runErr = runErr
		b.mu.Unlock()
		close(b.done)
	}()

	return b.waitReady(15 * time.Second)
}

func (b *bridgeRuntime) waitReady(timeout time.Duration) error {
	select {
	case <-b.ready:
		return b.checkListening()
	case <-b.done:
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.runErr == nil {
			return errors.New("VideoLens Bridge stopped before becoming ready")
		}
		return fmt.Errorf("start VideoLens Bridge: %w", b.runErr)
	case <-time.After(timeout):
		return errors.New("timed out while starting VideoLens Bridge")
	}
}

func (b *bridgeRuntime) checkListening() error {
	connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", bridgePort), 2*time.Second)
	if err != nil {
		return fmt.Errorf("VideoLens Bridge is not listening on port %d: %w", bridgePort, err)
	}
	_ = connection.Close()
	return nil
}

func (b *bridgeRuntime) handle(request nativeRequest) nativeResponse {
	response := nativeResponse{ID: request.ID, OK: true}
	switch request.Type {
	case "models.list":
		if request.Data["provider"] != "gpt" || b.modelCatalog == nil {
			response.OK = false
			response.Error = "该账号模型目录暂不可用。"
			return response
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		force, _ := request.Data["refresh"].(bool)
		catalog, err := b.modelCatalog.List(ctx, force)
		if err != nil {
			response.OK = false
			response.Error = err.Error()
		} else {
			response.Data = catalog
		}
	case "text.config":
		data, err := b.textConfig()
		if err != nil {
			response.OK = false
			response.Error = err.Error()
		} else {
			response.Data = data
		}
	case "bridge.config", "bridge.ping":
		if err := b.waitReady(5 * time.Second); err != nil {
			response.OK = false
			response.Error = err.Error()
			return response
		}
		response.Data = map[string]any{
			"version":            bridgeVersion,
			"gatewayBaseUrl":     fmt.Sprintf("http://127.0.0.1:%d", bridgePort),
			"clientApiKey":       b.secrets.ClientAPIKey,
			"managementKey":      b.secrets.ManagementKey,
			"networkProxySource": b.networkProxySource,
		}
	case "credentials.clear":
		removed, err := b.clearCredentials()
		if err != nil {
			response.OK = false
			response.Error = err.Error()
			return response
		}
		response.Data = map[string]any{"removed": removed}
	default:
		response.OK = false
		response.Error = "unsupported native message type"
	}
	return response
}

func (b *bridgeRuntime) clearCredentials() (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	cleanAuthDir := filepath.Clean(b.authDir)
	cleanDataDir := filepath.Clean(b.dataDir)
	if filepath.Dir(cleanAuthDir) != cleanDataDir || filepath.Base(cleanAuthDir) != "auths" {
		return 0, errors.New("refusing to clear an unexpected credential directory")
	}

	entries, err := os.ReadDir(cleanAuthDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, os.MkdirAll(cleanAuthDir, 0o700)
		}
		return 0, fmt.Errorf("read credential directory: %w", err)
	}

	removed := 0
	for _, entry := range entries {
		target := filepath.Join(cleanAuthDir, entry.Name())
		if err = os.RemoveAll(target); err != nil {
			return removed, fmt.Errorf("remove local account credential: %w", err)
		}
		removed++
	}
	if err = os.MkdirAll(cleanAuthDir, 0o700); err != nil {
		return removed, fmt.Errorf("restore credential directory: %w", err)
	}
	time.Sleep(250 * time.Millisecond)
	return removed, nil
}

func bridgeDataDir() (string, error) {
	if runtime.GOOS == "windows" {
		base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if base == "" {
			return "", errors.New("LOCALAPPDATA is not available")
		}
		return filepath.Join(base, "VideoLens", "Bridge"), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	return filepath.Join(base, "VideoLens", "Bridge"), nil
}

func loadOrCreateSecrets(path string) (bridgeSecrets, error) {
	var secrets bridgeSecrets
	data, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(data, &secrets); err != nil {
			return secrets, fmt.Errorf("parse bridge secrets: %w", err)
		}
		if secrets.ClientAPIKey != "" && secrets.ManagementKey != "" && secrets.TextAPIKey != "" {
			return secrets, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return secrets, fmt.Errorf("read bridge secrets: %w", err)
	}

	if secrets.ClientAPIKey == "" {
		if secrets.ClientAPIKey, err = randomSecret("vl_client_"); err != nil {
			return secrets, err
		}
	}
	if secrets.ManagementKey == "" {
		if secrets.ManagementKey, err = randomSecret("vl_mgmt_"); err != nil {
			return secrets, err
		}
	}
	if secrets.TextAPIKey == "" {
		if secrets.TextAPIKey, err = randomSecret("vl_text_"); err != nil {
			return secrets, err
		}
	}
	data, err = json.MarshalIndent(secrets, "", "  ")
	if err != nil {
		return secrets, fmt.Errorf("encode bridge secrets: %w", err)
	}
	if err = os.WriteFile(path, data, 0o600); err != nil {
		return secrets, fmt.Errorf("write bridge secrets: %w", err)
	}
	return secrets, nil
}

func randomSecret(prefix string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate bridge secret: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func writeBridgeConfig(path, authDir string, secrets bridgeSecrets, proxyURL string) error {
	quote := func(value string) string {
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
	content := fmt.Sprintf(`host: "127.0.0.1"
port: %d
tls:
  enable: false
  cert: ""
  key: ""
remote-management:
  allow-remote: false
  secret-key: %s
  disable-control-panel: true
auth-dir: %s
api-keys:
  - %s
proxy-url: %s
debug: false
logging-to-file: false
usage-statistics-enabled: false
commercial-mode: true
`, bridgePort, quote(secrets.ManagementKey), quote(authDir), quote(secrets.ClientAPIKey), quote(proxyURL))
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return fmt.Errorf("write bridge configuration: %w", err)
	}
	return nil
}

func readNativeMessage(reader io.Reader) (nativeRequest, error) {
	var request nativeRequest
	var length uint32
	if err := binary.Read(reader, binary.LittleEndian, &length); err != nil {
		return request, err
	}
	if length == 0 || length > maxNativeMessage {
		return request, fmt.Errorf("invalid native message length: %d", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return request, err
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return request, fmt.Errorf("parse native message: %w", err)
	}
	if request.Type == "" {
		return request, errors.New("native message type is required")
	}
	return request, nil
}

func writeNativeMessage(writer io.Writer, response nativeResponse) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(payload) > maxNativeMessage {
		return errors.New("native response is too large")
	}
	if err = binary.Write(writer, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	_, err = writer.Write(payload)
	return err
}
