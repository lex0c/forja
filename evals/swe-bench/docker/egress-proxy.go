// self-SWE-bench egress allowlist proxy. The bench task container routes ALL egress through this
// (HTTPS_PROXY); combined with the `--internal` network (no direct route), the agent reaches ONLY
// the hosts on the allowlist — the model endpoint — and NOTHING else (notably not github.com, where
// the gold fix lives). A CONNECT proxy (HTTPS tunneling): the client sends `CONNECT host:port`, we
// check the host against the allowlist and either tunnel raw TCP or refuse with 403. The proxy — not
// the container — resolves the target host, so the task container needs no DNS of its own.
//
// Go (static binary, no runtime) for a long-running sidecar across a full bench run. Stdlib only.
// Env: EGRESS_ALLOW (comma list, host or .suffix; default ollama.com), EGRESS_PORT (default 8889).
package main

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func allowed(host string, allow []string) bool {
	for _, a := range allow {
		if a != "" && (host == a || strings.HasSuffix(host, "."+a)) {
			return true
		}
	}
	return false
}

func main() {
	port := envOr("EGRESS_PORT", "8889")
	allow := splitTrim(envOr("EGRESS_ALLOW", "ollama.com"))

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "egress-proxy: CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "egress-proxy: hijack unsupported", http.StatusInternalServerError)
			return
		}
		// Hijack EARLY — take ownership so WE close the connection on EVERY path. Responding to a
		// CONNECT via http.Error LEAKS it: the server keeps it half-open (it expects the handler to
		// hijack a CONNECT), and the fd piles up over a run until the proxy exhausts descriptors.
		// (Caught by the fd-leak load test — refused + dial-fail paths now close explicitly.)
		client, bufrw, err := hj.Hijack()
		if err != nil {
			return
		}
		if !allowed(r.URL.Hostname(), allow) {
			log.Printf("DENY  %s", r.Host)
			_, _ = client.Write([]byte("HTTP/1.1 403 Forbidden\r\n\r\n"))
			client.Close()
			return
		}
		upstream, err := net.DialTimeout("tcp", r.Host, 15*time.Second)
		if err != nil {
			_, _ = client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			client.Close()
			return
		}
		log.Printf("ALLOW %s", r.Host)
		_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		// Splice both directions. Each side closes BOTH conns on EOF/error, so a half-open peer
		// unblocks its pair — no goroutine and no fd survives the connection. bufrw.Reader carries
		// any bytes the client pipelined after CONNECT (rare, but don't drop them).
		go splice(upstream, bufrw.Reader, client, upstream)
		go splice(client, upstream, client, upstream)
	})

	srv := &http.Server{Addr: "0.0.0.0:" + port, Handler: handler}
	log.Printf("egress-proxy: listening on 0.0.0.0:%s, allow=%v", port, allow)
	log.Fatal(srv.ListenAndServe())
}

// splice copies src→dst, then closes BOTH connections (a, b) so the paired goroutine unblocks too.
// Double-close on the already-closed side is a harmless no-op error we ignore.
func splice(dst io.Writer, src io.Reader, a, b net.Conn) {
	_, _ = io.Copy(dst, src)
	a.Close()
	b.Close()
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func splitTrim(s string) []string {
	parts := strings.Split(s, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}
