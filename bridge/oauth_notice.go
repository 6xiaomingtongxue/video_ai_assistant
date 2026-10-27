package main

import (
	"bytes"
	"strings"

	"github.com/gin-gonic/gin"
)

const oauthReceivedHTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VideoLens 授权确认</title></head><body><h1>授权结果已接收</h1><p>请返回 VideoLens 助手查看连接结果。</p><p>账号连接完成后，助手才会显示“已连接”。如助手提示错误，请以该结果为准。</p></body></html>`

type oauthNoticeWriter struct {
	gin.ResponseWriter
	replaced bool
}

func (w *oauthNoticeWriter) Write(data []byte) (int, error) {
	if w.Status() == 200 && strings.Contains(w.Header().Get("Content-Type"), "text/html") &&
		(w.replaced || bytes.Contains(data, []byte("Authentication successful"))) {
		if w.replaced {
			return len(data), nil
		}
		w.replaced = true
		w.Header().Del("Content-Length")
		_, err := w.ResponseWriter.Write([]byte(oauthReceivedHTML))
		return len(data), err
	}
	return w.ResponseWriter.Write(data)
}

func (w *oauthNoticeWriter) WriteString(data string) (int, error) { return w.Write([]byte(data)) }

func oauthCallbackNotice(c *gin.Context) {
	if c.Request.Method == "GET" && (c.Request.URL.Path == "/codex/callback" || c.Request.URL.Path == "/anthropic/callback" || c.Request.URL.Path == "/google/callback") {
		c.Header("Cache-Control", "no-store")
		c.Header("Referrer-Policy", "no-referrer")
		c.Writer = &oauthNoticeWriter{ResponseWriter: c.Writer}
	}
	c.Next()
}
