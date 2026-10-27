package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestOAuthNoticeDoesNotClaimConnectionSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(oauthCallbackNotice)
	for _, path := range []string{"/codex/callback", "/anthropic/callback", "/google/callback", "/unrelated"} {
		router.GET(path, func(c *gin.Context) {
			if c.Query("error") != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "callback rejected"})
				return
			}
			c.Header("Content-Type", "text/html; charset=utf-8")
			c.String(http.StatusOK, "<h1>Authentication successful!</h1>")
		})
	}
	for _, path := range []string{"/codex/callback?code=test-private-code", "/anthropic/callback", "/google/callback"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		body := response.Body.String()
		if response.Code != 200 || !strings.Contains(body, "授权结果已接收") || strings.Contains(body, "Authentication successful") || strings.Contains(body, "test-private-code") {
			t.Fatal("callback page must acknowledge receipt without asserting connection success or reflecting codes")
		}
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/codex/callback?error=denied", nil))
	if response.Code != 400 || !strings.Contains(response.Body.String(), "callback rejected") {
		t.Fatal("callback errors must not be replaced")
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/unrelated", nil))
	if !strings.Contains(response.Body.String(), "Authentication successful") {
		t.Fatal("unrelated responses must not change")
	}
}
