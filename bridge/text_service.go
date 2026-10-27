package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const textServiceURL = "http://127.0.0.1:18318"

func probeTextService(baseURL, key string) bool {
	client := &http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	request, err := http.NewRequest(http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return false
	}
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var health struct {
		Service         string `json:"service"`
		WholeVideoText  bool   `json:"wholeVideoText"`
		ProgressiveText bool   `json:"progressiveText"`
		Schema          int    `json:"schema"`
	}
	return response.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) == nil &&
		health.Service == "videolens-video-text" && health.WholeVideoText && health.ProgressiveText && health.Schema == 1
}

// Polling never blocks Native Messaging while first-run dependencies download.
func (b *bridgeRuntime) textConfig() (map[string]any, error) {
	if probeTextService(textServiceURL, b.secrets.TextAPIKey) {
		return map[string]any{"status": "ready", "baseUrl": textServiceURL + "/v1", "apiKey": b.secrets.TextAPIKey,
			"model": "Systran/faster-whisper-small", "progressiveText": true}, nil
	}
	b.textMu.Lock()
	defer b.textMu.Unlock()
	if b.textErr != nil && time.Since(b.textFailedAt) < 30*time.Second {
		return nil, b.textErr
	}
	if !b.textStarting {
		b.textStarting = true
		b.textErr = nil
		go func() {
			err := b.startTextService()
			b.textMu.Lock()
			defer b.textMu.Unlock()
			b.textStarting = false
			b.textErr = err
			if err != nil {
				b.textFailedAt = time.Now()
			}
		}()
	}
	return map[string]any{"status": "starting"}, nil
}

func textRuntimeReady(serviceDir string) bool {
	requirements, err := os.ReadFile(filepath.Join(serviceDir, "requirements.txt"))
	if err != nil {
		return false
	}
	marker, err := os.ReadFile(filepath.Join(serviceDir, "runtime", "ready.json"))
	if err != nil {
		return false
	}
	var ready struct {
		Schema           int    `json:"schema"`
		RequirementsHash string `json:"requirementsHash"`
	}
	if json.Unmarshal([]byte(strings.TrimPrefix(string(marker), "\ufeff")), &ready) != nil {
		return false
	}
	digest := sha256.Sum256(requirements)
	if ready.Schema != 1 || ready.RequirementsHash != hex.EncodeToString(digest[:]) {
		return false
	}
	for _, relative := range []string{"venv/Scripts/python.exe", "node/node.exe"} {
		info, err := os.Stat(filepath.Join(serviceDir, "runtime", filepath.FromSlash(relative)))
		if err != nil || info.IsDir() {
			return false
		}
	}
	return true
}

func (b *bridgeRuntime) startTextService() error {
	serviceDir := filepath.Join(b.dataDir, "text-service")
	for _, name := range []string{"server.py", "video_jobs.py", "setup-runtime.ps1", "requirements.txt"} {
		if _, err := os.Stat(filepath.Join(serviceDir, name)); err != nil {
			return errors.New("请更新 VideoLens Bridge，安装包会自动配置视频处理组件，无需填写地址。")
		}
	}
	if !textRuntimeReady(serviceDir) {
		setupLog, err := os.Create(filepath.Join(serviceDir, "setup.log"))
		if err != nil {
			return fmt.Errorf("无法准备本机视频处理环境：%w", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		setup := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-File", filepath.Join(serviceDir, "setup-runtime.ps1"), "-RuntimeDirectory", filepath.Join(serviceDir, "runtime"))
		hideProcessWindow(setup)
		setup.Stdout, setup.Stderr = setupLog, setupLog
		err = setup.Run()
		cancel()
		setupLog.Close()
		if err != nil || !textRuntimeReady(serviceDir) {
			return errors.New("视频处理环境自动准备失败，请检查网络后重试。详细记录位于 VideoLens Bridge/text-service/setup.log。")
		}
	}
	// Recheck after setup: another Bridge may already have started the shared service.
	if probeTextService(textServiceURL, b.secrets.TextAPIKey) {
		return nil
	}
	serviceLog, err := os.OpenFile(filepath.Join(serviceDir, "service.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	command := exec.Command(filepath.Join(serviceDir, "runtime", "venv", "Scripts", "python.exe"), filepath.Join(serviceDir, "server.py"))
	hideProcessWindow(command)
	command.Dir = serviceDir
	command.Env = append(os.Environ(), "PYTHONUTF8=1", "VIDEOLENS_TEXT_HOST=127.0.0.1", "VIDEOLENS_TEXT_PORT=18318",
		"VIDEOLENS_TEXT_DATA="+filepath.Join(serviceDir, "data"), "VIDEOLENS_API_KEY="+b.secrets.TextAPIKey,
		"PATH="+filepath.Join(serviceDir, "runtime", "node")+string(os.PathListSeparator)+os.Getenv("PATH"))
	command.Stdout, command.Stderr = serviceLog, serviceLog
	if err = command.Start(); err != nil {
		serviceLog.Close()
		return fmt.Errorf("无法启动本机视频处理服务：%w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait(); serviceLog.Close() }()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if probeTextService(textServiceURL, b.secrets.TextAPIKey) {
			return nil
		}
		select {
		case <-exited:
			return errors.New("本机视频处理服务启动失败，请检查端口 18318 是否被其他程序占用，详细记录见 text-service/service.log。")
		case <-time.After(200 * time.Millisecond):
		}
	}
	_ = command.Process.Kill()
	return errors.New("本机视频处理服务启动超时，请重试。")
}
