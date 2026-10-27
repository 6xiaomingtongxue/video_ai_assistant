package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeMessageRoundTrip(t *testing.T) {
	payload := []byte(`{"id":"request-1","type":"bridge.ping"}`)
	var framed bytes.Buffer
	if err := binary.Write(&framed, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	if _, err := framed.Write(payload); err != nil {
		t.Fatal(err)
	}

	request, err := readNativeMessage(&framed)
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != "request-1" || request.Type != "bridge.ping" {
		t.Fatalf("unexpected request: %#v", request)
	}

	var responseBuffer bytes.Buffer
	if err = writeNativeMessage(&responseBuffer, nativeResponse{ID: request.ID, OK: true}); err != nil {
		t.Fatal(err)
	}
	var length uint32
	if err = binary.Read(&responseBuffer, binary.LittleEndian, &length); err != nil {
		t.Fatal(err)
	}
	responsePayload := make([]byte, length)
	if _, err = responseBuffer.Read(responsePayload); err != nil {
		t.Fatal(err)
	}
	var response nativeResponse
	if err = json.Unmarshal(responsePayload, &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.ID != "request-1" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestRejectsOversizedNativeMessage(t *testing.T) {
	var framed bytes.Buffer
	if err := binary.Write(&framed, binary.LittleEndian, uint32(maxNativeMessage+1)); err != nil {
		t.Fatal(err)
	}
	if _, err := readNativeMessage(&framed); err == nil {
		t.Fatal("expected oversized message to fail")
	}
}

func TestClearCredentialsRemovesAccountAndOAuthArtifacts(t *testing.T) {
	dataDir := t.TempDir()
	authDir := filepath.Join(dataDir, "auths")
	if err := os.MkdirAll(filepath.Join(authDir, "pending"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"account.json":                    `{"provider":"codex"}`,
		"oauth-callback-state.tmp":        `{"code":"temporary"}`,
		filepath.Join("pending", "state"): "temporary",
	} {
		if err := os.WriteFile(filepath.Join(authDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	bridge := &bridgeRuntime{dataDir: dataDir, authDir: authDir}
	removed, err := bridge.clearCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if removed != 3 {
		t.Fatalf("expected 3 top-level credential artifacts to be removed, got %d", removed)
	}
	entries, err := os.ReadDir(authDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected credential directory to be empty, got %d entries", len(entries))
	}
}

func TestClearCredentialsRejectsUnexpectedDirectory(t *testing.T) {
	dataDir := t.TempDir()
	bridge := &bridgeRuntime{
		dataDir: dataDir,
		authDir: filepath.Join(dataDir, "other"),
	}
	if _, err := bridge.clearCredentials(); err == nil {
		t.Fatal("expected unexpected credential directory to be rejected")
	}
}
