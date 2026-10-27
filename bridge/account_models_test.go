package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type catalogTestManager struct {
	mu        sync.Mutex
	auth      *coreauth.Auth
	refreshes int
}

func (m *catalogTestManager) List() []*coreauth.Auth {
	m.mu.Lock()
	defer m.mu.Unlock()
	return []*coreauth.Auth{nil, m.auth.Clone()}
}
func (m *catalogTestManager) GetByID(id string) (*coreauth.Auth, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.auth.Clone(), m.auth.ID == id
}
func (m *catalogTestManager) RefreshSchedulerEntry(string) { m.mu.Lock(); m.refreshes++; m.mu.Unlock() }

const testAccountCatalog = `{"models":[
 {"slug":"codex-auto-review","visibility":"hide","supported_in_api":true,"input_modalities":["text"]},
 {"slug":"future-chat-z","display_name":"Current text model","visibility":"list","supported_in_api":true,"input_modalities":["text"],"context_window":100000,"base_instructions":"untrusted instructions must not enter model-list output"},
 {"slug":"gpt-image-2","visibility":"list","supported_in_api":true,"input_modalities":["text"],"output_modalities":["image"]},
 {"slug":"future-vision-a","display_name":"Current vision model","visibility":"list","supported_in_api":true,"input_modalities":["text","image"]},
 {"slug":"not-api","visibility":"list","supported_in_api":false,"input_modalities":["text"]},
 {"slug":"audio-only","visibility":"list","input_modalities":["audio"]},
 {"slug":"image-only","visibility":"list","input_modalities":["text"],"output_modalities":["image"]},
 {"slug":"future-chat-z","visibility":"list","input_modalities":["text"]}
]}`

func catalogFixture(t *testing.T, handler http.HandlerFunc) (*accountModelCatalog, *catalogTestManager) {
	t.Helper()
	manager := &catalogTestManager{auth: &coreauth.Auth{ID: "catalog-" + t.Name(), Provider: "codex", Metadata: map[string]any{"access_token": "private-fixture-token", "account_id": "private-fixture-account"}}}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	registry := cliproxy.GlobalModelRegistry()
	catalog, err := newAccountModelCatalog(manager, registry, "direct")
	if err != nil {
		t.Fatal(err)
	}
	catalog.endpoint = server.URL
	catalog.gatewayKey = "private-fixture-client-key"
	t.Cleanup(func() { registry.UnregisterClient(manager.auth.ID) })
	return catalog, manager
}

func TestAccountCatalogFiltersAndRegistersCurrentModels(t *testing.T) {
	var requests atomic.Int32
	catalog, manager := catalogFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		accountID := r.Header.Get("Chatgpt-Account-Id")
		if r.Header.Get("Authorization") != "Bearer private-fixture-token" || (accountID != "private-fixture-account" && accountID != "changed-account") {
			t.Error("account credentials must stay in the upstream request")
		}
		_, _ = w.Write([]byte(testAccountCatalog))
	})
	clock := time.Now()
	catalog.now = func() time.Time { return clock }
	result, err := catalog.List(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Models) != 2 || result.Models[0].ID != "future-chat-z" || result.Models[1].ID != "future-vision-a" {
		t.Fatal("keep the upstream order and only visible text-chat models")
	}
	if result.Models[0].SupportsVision || !result.Models[1].SupportsVision {
		t.Fatal("vision capability must follow the upstream catalog")
	}
	if !catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") || catalog.registry.ClientSupportsModel(manager.auth.ID, "gpt-image-2") {
		t.Fatal("current models must also be registered for execution")
	}
	encoded, _ := json.Marshal(result)
	for _, private := range []string{"private-fixture-token", "private-fixture-account", "base_instructions", "untrusted instructions"} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("model list output exposed a credential or unneeded upstream instructions")
		}
	}
	_, _ = catalog.List(context.Background(), false)
	if requests.Load() != 1 {
		t.Fatal("ordinary requests should share the short-lived account catalog")
	}
	_, _ = catalog.List(context.Background(), true)
	if requests.Load() != 2 {
		t.Fatal("manual refresh must bypass the cache")
	}
	clock = clock.Add(accountModelsTTL + time.Second)
	_, _ = catalog.List(context.Background(), false)
	if requests.Load() != 3 {
		t.Fatal("expired catalogs must refresh")
	}
	manager.mu.Lock()
	manager.auth.Metadata["account_id"] = "changed-account"
	manager.mu.Unlock()
	_, _ = catalog.List(context.Background(), false)
	if requests.Load() != 4 {
		t.Fatal("switching accounts must not reuse another account's model catalog")
	}
}

func TestCatalogFailureNeverFallsBackToBundledModels(t *testing.T) {
	var rejected atomic.Bool
	var requests atomic.Int32
	catalog, manager := catalogFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		if rejected.Load() {
			w.WriteHeader(503)
			_, _ = w.Write([]byte("private upstream detail"))
			return
		}
		_, _ = w.Write([]byte(testAccountCatalog))
	})
	if _, err := catalog.List(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	rejected.Store(true)
	result, err := catalog.List(context.Background(), true)
	if err == nil || len(result.Models) != 0 || strings.Contains(err.Error(), "private upstream detail") {
		t.Fatal("a failed refresh must not pretend a static or old list is current")
	}
	if catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") {
		t.Fatal("failed credentials must not retain unverified model registrations")
	}
	_, _ = catalog.List(context.Background(), false)
	if requests.Load() != 2 {
		t.Fatal("polling should briefly back off after a catalog failure")
	}
	if manager.auth.Disabled || manager.auth.Metadata["access_token"] == nil {
		t.Fatal("a temporary catalog failure must preserve the account")
	}
}

func TestCatalogProtectsRegistrationAcrossSDKRefresh(t *testing.T) {
	catalog, manager := catalogFixture(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(testAccountCatalog)) })
	old := []*cliproxy.ModelInfo{{ID: "obsolete-bundled-model"}}
	catalog.registry.RegisterClient(manager.auth.ID, "codex", old)
	catalog.OnModelsRegistered(context.Background(), "codex", manager.auth.ID, old)
	if catalog.registry.ClientSupportsModel(manager.auth.ID, old[0].ID) {
		t.Fatal("the bundled fallback must not be exposed before a live catalog is loaded")
	}
	if _, err := catalog.List(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	catalog.registry.RegisterClient(manager.auth.ID, "codex", old)
	catalog.OnModelsRegistered(context.Background(), "codex", manager.auth.ID, old)
	if !catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") || catalog.registry.ClientSupportsModel(manager.auth.ID, old[0].ID) {
		t.Fatal("token refresh must not replace the live catalog with the SDK snapshot")
	}
	catalog.registry.UnregisterClient(manager.auth.ID)
	catalog.OnModelsUnregistered(context.Background(), "codex", manager.auth.ID)
	if !catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") {
		t.Fatal("a delayed SDK unregister event must not erase a newer verified catalog")
	}
	catalog.registry.RegisterClient(manager.auth.ID, "codex", old)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(catalog.restoreForInference)
	router.POST("/v1/chat/completions", func(c *gin.Context) {
		if !catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") {
			t.Error("inference routing must see the current model catalog")
		}
		c.Status(200)
	})
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("Authorization", "Bearer private-fixture-client-key")
	router.ServeHTTP(httptest.NewRecorder(), request)
	manager.mu.Lock()
	manager.auth.Disabled = true
	manager.mu.Unlock()
	catalog.OnModelsRegistered(context.Background(), "codex", manager.auth.ID, old)
	if catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") {
		t.Fatal("disabled accounts must not be resurrected by a registry hook")
	}
}

func TestInferenceLoadsCatalogInServingProcessAndRefreshesExpiry(t *testing.T) {
	var requests atomic.Int32
	catalog, manager := catalogFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(testAccountCatalog))
	})
	clock := time.Now()
	catalog.now = func() time.Time { return clock }
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(catalog.restoreForInference)
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		router.POST(path, func(c *gin.Context) {
			if c.GetHeader("Authorization") != "Bearer private-fixture-client-key" {
				c.Status(401)
				return
			}
			if !catalog.registry.ClientSupportsModel(manager.auth.ID, "future-chat-z") {
				t.Error("serving process must load the catalog without a native models.list request")
			}
			c.Status(200)
		})
	}
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/chat/completions", nil))
	if requests.Load() != 0 {
		t.Fatal("unauthenticated HTTP callers must not trigger credentialed upstream requests")
	}
	for index, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		if index > 0 {
			clock = clock.Add(accountModelsTTL + time.Second)
			catalog.registry.UnregisterClient(manager.auth.ID)
		}
		request := httptest.NewRequest("POST", path, nil)
		request.Header.Set("Authorization", "Bearer private-fixture-client-key")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != 200 || requests.Load() != int32(index+1) {
			t.Fatal("cold and expired serving-process catalogs must refresh before routing")
		}
	}
}

func TestInferenceCatalogFailureAbortsBeforeRouting(t *testing.T) {
	catalog, _ := catalogFixture(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(catalog.restoreForInference)
	router.POST("/v1/chat/completions", func(c *gin.Context) {
		t.Error("a catalog failure must not route using bundled or unknown models")
		c.Status(200)
	})
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("Authorization", "Bearer private-fixture-client-key")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "account_catalog_unavailable") {
		t.Fatal("return an actionable catalog error rather than an unknown-provider response")
	}
}

func TestCatalogRejectsRedirectsAndInvalidPayloads(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	catalog, _ := catalogFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) })
	if _, err := catalog.List(context.Background(), true); err == nil || redirected.Load() != 0 {
		t.Fatal("catalog credentials must not follow redirects")
	}
	invalid, _ := catalogFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"old-static-model"}]}`))
	})
	if _, err := invalid.List(context.Background(), false); err == nil {
		t.Fatal("a legacy API-shaped snapshot must not be mistaken for an account catalog")
	}
}
