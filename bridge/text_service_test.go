package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestTextProbeRequiresIdentityAndCredential(t *testing.T) {
	var validIdentity atomic.Bool
	validIdentity.Store(true)
	var progressive atomic.Bool
	progressive.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Header.Get("Authorization") != "Bearer text-only-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		service := "videolens-video-text"
		if !validIdentity.Load() {
			service = "unrelated-local-server"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"service": service, "schema": 1, "wholeVideoText": true,
			"progressiveText": progressive.Load()})
	}))
	defer server.Close()
	if probeTextService(server.URL, "incorrect-key") {
		t.Fatal("must not accept another service's credentials")
	}
	if !probeTextService(server.URL, "text-only-key") {
		t.Fatal("expected a healthy managed service")
	}
	progressive.Store(false)
	if probeTextService(server.URL, "text-only-key") {
		t.Fatal("a legacy worker cannot be used for progressive text")
	}
	progressive.Store(true)
	validIdentity.Store(false)
	if probeTextService(server.URL, "text-only-key") {
		t.Fatal("must not use an unrelated local server")
	}
}

func TestManagedRuntimeRequiresCompleteMatchingInstall(t *testing.T) {
	directory := t.TempDir()
	requirements := []byte("faster-whisper>=1.2.0,<2\nyt-dlp[default]\n")
	if err := os.WriteFile(filepath.Join(directory, "requirements.txt"), requirements, 0o600); err != nil {
		t.Fatal(err)
	}
	if textRuntimeReady(directory) {
		t.Fatal("incomplete runtime cannot be ready")
	}
	for _, relative := range []string{"venv/Scripts/python.exe", "node/node.exe"} {
		path := filepath.Join(directory, "runtime", filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("test executable"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256.Sum256(requirements)
	marker, _ := json.Marshal(map[string]any{"schema": 1, "requirementsHash": hex.EncodeToString(digest[:])})
	if err := os.WriteFile(filepath.Join(directory, "runtime", "ready.json"), append([]byte("\xef\xbb\xbf"), marker...), 0o600); err != nil {
		t.Fatal(err)
	}
	if !textRuntimeReady(directory) {
		t.Fatal("complete matching runtime must be reusable")
	}
	if err := os.WriteFile(filepath.Join(directory, "requirements.txt"), []byte("changed dependency"), 0o600); err != nil {
		t.Fatal(err)
	}
	if textRuntimeReady(directory) {
		t.Fatal("dependency changes must trigger setup again")
	}
}

func TestSecretUpgradePreservesExistingAccountKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge-secrets.json")
	if err := os.WriteFile(path, []byte(`{"clientApiKey":"original-client","managementKey":"original-management"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	secrets, err := loadOrCreateSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	if secrets.ClientAPIKey != "original-client" || secrets.ManagementKey != "original-management" || secrets.TextAPIKey == "" {
		t.Fatal("upgrade must keep existing keys and add a separate text service credential")
	}
	reloaded, err := loadOrCreateSecrets(path)
	if err != nil || reloaded != secrets {
		t.Fatal("service restarts must reuse the same text credential")
	}
}

func TestMissingTextComponentsReportUpgrade(t *testing.T) {
	bridge := &bridgeRuntime{dataDir: t.TempDir()}
	if err := bridge.startTextService(); err == nil {
		t.Fatal("missing install components must not be reported ready")
	}
}
