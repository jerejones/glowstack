// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package httpserver is Glowstack's one HTTP listener. Services register
// their routes on it under their own prefixes: the live map owns `/map/`
// and `/api/map/`, the control API owns `/api/v1/`. Routes may be added
// while the server runs (http.ServeMux allows it), so a service can
// register when it starts.
package httpserver

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Server is the shared HTTP server.
type Server struct {
	Addr string
	Log  *slog.Logger
	mux  *http.ServeMux
}

// New returns a server that will listen on addr (e.g. ":8080").
func New(addr string, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{Addr: addr, Log: log, mux: http.NewServeMux()}
}

// Handle registers h for pattern (http.ServeMux syntax, e.g.
// "GET /api/map/geometry").
func (s *Server) Handle(pattern string, h http.Handler) { s.mux.Handle(pattern, h) }

// HandleFunc registers fn for pattern.
func (s *Server) HandleFunc(pattern string, fn http.HandlerFunc) { s.mux.HandleFunc(pattern, fn) }

// ServeHTTP implements http.Handler, so tests can drive the server
// without a listener.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// Run listens and serves until ctx is done, then shuts down gracefully.
// Long-lived connections (websockets) are closed by their handlers when
// they see the request context end.
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           s.mux,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	s.Log.Info("http listening", "addr", ln.Addr().String())
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = srv.Shutdown(sctx)
	if errors.Is(err, context.DeadlineExceeded) {
		err = srv.Close()
	}
	if serr := <-errc; !errors.Is(serr, http.ErrServerClosed) {
		err = errors.Join(err, serr)
	}
	return err
}
