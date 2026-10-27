package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

// Match the current Codex catalog protocol, not the model snapshot bundled in CPA.
const codexCatalogVersion = "0.164.0"
const codexCatalogURL = "https://chatgpt.com/backend-api/codex/models?client_version=" + codexCatalogVersion
const accountModelsTTL = 5 * time.Minute

type catalogAuthManager interface {
	List() []*coreauth.Auth
	GetByID(string) (*coreauth.Auth, bool)
	RefreshSchedulerEntry(string)
}

type accountChatModel struct {
	ID             string `json:"id"`
	Provider       string `json:"provider"`
	DisplayName    string `json:"displayName"`
	SupportsVision bool   `json:"supportsVision"`
	ContextLength  int    `json:"contextLength"`
}

type accountModelsResult struct {
	Source      string             `json:"source"`
	Models      []accountChatModel `json:"models"`
	RefreshedAt int64              `json:"refreshedAt"`
}

type accountModelsCache struct {
	accountKey string
	models     []accountChatModel
	updated    time.Time
	failure    error
}

type accountModelCatalog struct {
	gatewayKey string
	manager    catalogAuthManager
	registry   cliproxy.ModelRegistry
	client     *http.Client
	endpoint   string
	mu         sync.Mutex
	fetchMu    sync.Mutex
	cache      map[string]accountModelsCache
	now        func() time.Time
}

func newAccountModelCatalog(manager catalogAuthManager, registry cliproxy.ModelRegistry, proxyURL string) (*accountModelCatalog, error) {
	transport, _, err := proxyutil.BuildHTTPTransport(proxyURL)
	if err != nil {
		return nil, errors.New("账号模型目录的网络代理配置无效。")
	}
	if transport == nil {
		if current, ok := http.DefaultTransport.(*http.Transport); ok {
			transport = current.Clone()
		} else {
			transport = &http.Transport{Proxy: http.ProxyFromEnvironment}
		}
	}
	return &accountModelCatalog{manager: manager, registry: registry, endpoint: codexCatalogURL,
		client: &http.Client{Transport: transport, Timeout: 8 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		cache: make(map[string]accountModelsCache), now: time.Now}, nil
}

func isCodexCatalogAuth(auth *coreauth.Auth) bool {
	if auth == nil || !strings.EqualFold(auth.Provider, "codex") || auth.Disabled {
		return false
	}
	token, _ := auth.Metadata["access_token"].(string)
	return strings.TrimSpace(token) != ""
}

func catalogAccountKey(auth *coreauth.Auth) string {
	digest := sha256.Sum256([]byte(auth.ID + "\x00" + fmt.Sprint(auth.Metadata["account_id"])))
	return hex.EncodeToString(digest[:])
}

func (c *accountModelCatalog) List(ctx context.Context, force bool) (accountModelsResult, error) {
	c.fetchMu.Lock()
	defer c.fetchMu.Unlock()
	result := accountModelsResult{Source: "account", Models: []accountChatModel{}}
	auths := []*coreauth.Auth{}
	for _, auth := range c.manager.List() {
		if isCodexCatalogAuth(auth) {
			auths = append(auths, auth)
		}
	}
	sort.Slice(auths, func(i, j int) bool { return auths[i].ID < auths[j].ID })
	seen := make(map[string]bool)
	matched := false
	for _, auth := range auths {
		if !isCodexCatalogAuth(auth) {
			continue
		}
		matched = true
		entry, err := c.modelsForAuth(ctx, auth, force)
		if err != nil {
			return result, err
		}
		current, exists := c.manager.GetByID(auth.ID)
		if !exists || !isCodexCatalogAuth(current) || catalogAccountKey(current) != entry.accountKey {
			c.drop(auth.ID)
			return result, errors.New("账号已切换，请重新刷新模型列表。")
		}
		c.register(auth.ID, entry.models)
		if result.RefreshedAt == 0 || entry.updated.UnixMilli() < result.RefreshedAt {
			result.RefreshedAt = entry.updated.UnixMilli()
		}
		for _, model := range entry.models {
			if !seen[model.ID] {
				seen[model.ID] = true
				result.Models = append(result.Models, model)
			}
		}
	}
	if !matched {
		return result, errors.New("ChatGPT / Codex 账号凭证尚未就绪，请稍后刷新状态。")
	}
	return result, nil
}

func (c *accountModelCatalog) modelsForAuth(ctx context.Context, auth *coreauth.Auth, force bool) (accountModelsCache, error) {
	key := catalogAccountKey(auth)
	c.mu.Lock()
	entry, found := c.cache[auth.ID]
	c.mu.Unlock()
	if !force && found && entry.accountKey == key {
		age := c.now().Sub(entry.updated)
		if entry.failure != nil && age < 5*time.Second {
			return entry, entry.failure
		}
		if entry.failure == nil && age < accountModelsTTL {
			return entry, nil
		}
	}
	models, err := c.fetch(ctx, auth)
	entry = accountModelsCache{accountKey: key, models: models, updated: c.now(), failure: err}
	c.mu.Lock()
	c.cache[auth.ID] = entry
	c.mu.Unlock()
	if err != nil {
		c.registry.UnregisterClient(auth.ID)
		c.manager.RefreshSchedulerEntry(auth.ID)
	}
	return entry, err
}

func (c *accountModelCatalog) fetch(ctx context.Context, auth *coreauth.Auth) ([]accountChatModel, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint, nil)
	if err != nil {
		return nil, errors.New("无法准备账号模型目录请求。")
	}
	request.Header.Set("Accept", "application/json")
	token, _ := auth.Metadata["access_token"].(string)
	if token == "" {
		return nil, errors.New("当前账号的访问凭证尚未就绪，请刷新状态。")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Originator", "codex_cli_rs")
	request.Header.Set("User-Agent", "codex_cli_rs/"+codexCatalogVersion+" (Windows; x86_64) VideoLens/"+bridgeVersion)
	if id, ok := auth.Metadata["account_id"].(string); ok && id != "" {
		request.Header.Set("Chatgpt-Account-Id", id)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, errors.New("无法连接账号模型目录，请检查网络后刷新状态。")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized {
			return nil, errors.New("账号模型目录认证失败（401），请刷新状态；若持续失败，请重新授权。")
		}
		return nil, fmt.Errorf("账号模型目录返回 %d，请检查账号权限和网络后刷新状态。", response.StatusCode)
	}
	var payload struct {
		Models []struct {
			Slug             string   `json:"slug"`
			DisplayName      string   `json:"display_name"`
			Visibility       string   `json:"visibility"`
			SupportedInAPI   *bool    `json:"supported_in_api"`
			InputModalities  []string `json:"input_modalities"`
			OutputModalities []string `json:"output_modalities"`
			ContextWindow    int      `json:"context_window"`
		} `json:"models"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&payload) != nil || payload.Models == nil {
		return nil, errors.New("账号模型目录格式无效，请更新 Bridge 或稍后刷新状态。")
	}
	models := []accountChatModel{}
	seen := make(map[string]bool)
	for _, model := range payload.Models {
		id := strings.TrimSpace(model.Slug)
		if id == "" || len(id) > 160 || strings.ContainsAny(id, " \t\r\n") || seen[id] || model.Visibility != "list" ||
			(model.SupportedInAPI != nil && !*model.SupportedInAPI) || !isChatModelID(id) ||
			(len(model.InputModalities) > 0 && !containsModality(model.InputModalities, "text")) ||
			(len(model.OutputModalities) > 0 && !containsModality(model.OutputModalities, "text")) {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(model.DisplayName)
		if name == "" {
			name = id
		}
		models = append(models, accountChatModel{ID: id, Provider: "gpt", DisplayName: name,
			SupportsVision: containsModality(model.InputModalities, "image"), ContextLength: model.ContextWindow})
	}
	return models, nil
}

func containsModality(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(value, expected) {
			return true
		}
	}
	return false
}

func isChatModelID(id string) bool {
	id = strings.ToLower(id)
	for _, prefix := range []string{"gpt-image", "dall-e", "whisper", "tts-", "sora", "text-embedding", "omni-moderation"} {
		if strings.HasPrefix(id, prefix) {
			return false
		}
	}
	return !strings.Contains(id, "auto-review")
}

func (c *accountModelCatalog) register(id string, models []accountChatModel) {
	infos := make([]*cliproxy.ModelInfo, 0, len(models))
	for _, model := range models {
		inputs := []string{"text"}
		if model.SupportsVision {
			inputs = append(inputs, "image")
		}
		infos = append(infos, &cliproxy.ModelInfo{ID: model.ID, Object: "model", OwnedBy: "openai", Type: "openai",
			DisplayName: model.DisplayName, ContextLength: model.ContextLength, UserDefined: true,
			SupportedInputModalities: inputs, SupportedOutputModalities: []string{"text"}})
	}
	c.registry.RegisterClient(id, "codex", infos)
	c.manager.RefreshSchedulerEntry(id)
}

func (c *accountModelCatalog) cachedForCurrentAuth(id string) (accountModelsCache, bool) {
	auth, found := c.manager.GetByID(id)
	if !found || !isCodexCatalogAuth(auth) {
		return accountModelsCache{}, false
	}
	c.mu.Lock()
	entry, found := c.cache[id]
	c.mu.Unlock()
	return entry, found && entry.accountKey == catalogAccountKey(auth) && entry.failure == nil && c.now().Sub(entry.updated) < accountModelsTTL
}

func (c *accountModelCatalog) drop(id string) {
	c.mu.Lock()
	delete(c.cache, id)
	c.mu.Unlock()
	c.registry.UnregisterClient(id)
	c.manager.RefreshSchedulerEntry(id)
}

// CPA may re-register its bundled list after token refresh. Keep account-derived
// registrations authoritative, and never expose the bundled Codex fallback.
func (c *accountModelCatalog) OnModelsRegistered(_ context.Context, provider, id string, models []*cliproxy.ModelInfo) {
	if provider != "codex" {
		return
	}
	entry, valid := c.cachedForCurrentAuth(id)
	if !valid {
		c.registry.UnregisterClient(id)
		c.manager.RefreshSchedulerEntry(id)
		return
	}
	if len(models) == len(entry.models) {
		ids := make(map[string]bool, len(entry.models))
		for _, model := range entry.models {
			ids[model.ID] = true
		}
		equal := true
		for _, model := range models {
			if model == nil || !model.UserDefined || !ids[model.ID] {
				equal = false
				break
			}
		}
		if equal {
			return
		}
	}
	c.register(id, entry.models)
}

func (c *accountModelCatalog) OnModelsUnregistered(_ context.Context, provider, id string) {
	if provider != "codex" {
		return
	}
	if entry, valid := c.cachedForCurrentAuth(id); valid {
		c.register(id, entry.models)
	}
}

func (c *accountModelCatalog) restoreForInference(context *gin.Context) {
	if context.Request.Method == "POST" && (context.Request.URL.Path == "/v1/chat/completions" || context.Request.URL.Path == "/v1/responses") {
		// This middleware runs before SDK auth. Do not contact the account catalog
		// on behalf of an unauthenticated local request.
		if c.gatewayKey == "" || !hmac.Equal([]byte(context.GetHeader("Authorization")), []byte("Bearer "+c.gatewayKey)) {
			context.Next()
			return
		}
		needsRefresh := false
		for _, auth := range c.manager.List() {
			if isCodexCatalogAuth(auth) {
				if entry, valid := c.cachedForCurrentAuth(auth.ID); valid {
					c.register(auth.ID, entry.models)
				} else {
					needsRefresh = true
				}
			}
		}
		// Native RPC and the shared HTTP gateway can be owned by different Bridge
		// processes. The serving process must hydrate its own registry as well.
		if needsRefresh {
			if _, err := c.List(context.Request.Context(), false); err != nil {
				context.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
					"message": err.Error(), "type": "account_catalog_unavailable",
				}})
				return
			}
		}
	}
	context.Next()
}
