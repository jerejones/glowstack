// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package httpserver is Glowstack's one HTTP server. Features register
// their routes on it (the control API under /api/v1/, the live map under
// /map/ and /api/map/), and it runs as an app.Service: it listens on the
// --http address and shuts down gracefully when the app stops.
//
// Long-lived connections (the live map's websockets) are hijacked, so
// Shutdown doesn't wait for them: their handlers end when the request
// context, derived from the app's, is done.
//
// Auth: there is none. Glowstack is meant for a trusted LAN. Authorize is
// the hook for adding it later; every request passes through it.
package httpserver

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/jerejones/glowstack/internal/app"
)

// ShutdownTimeout is how long in-flight requests get when the app stops.
const ShutdownTimeout = 5 * time.Second

// Mount registers a feature's routes. It's called once the App exists,
// before the server starts accepting connections.
type Mount func(a *app.App, s *Server) error

// Server is the shared HTTP server.
type Server struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string
	// Authorize, if set, vets every request. Returning an error refuses it
	// with 401 Unauthorized. nil allows everything (LAN only, for now).
	Authorize func(*http.Request) error

	mux     *http.ServeMux
	mounts  []Mount
	workers []func(context.Context) error
	addr    chan net.Addr
}

// New returns a server for addr with the given mounts.
func New(addr string, mounts ...Mount) *Server {
	return &Server{Addr: addr, mux: http.NewServeMux(), mounts: mounts, addr: make(chan net.Addr, 1)}
}

// Add appends mounts; call it before the service starts.
func (s *Server) Add(mounts ...Mount) { s.mounts = append(s.mounts, mounts...) }

// Handle registers h for a ServeMux pattern such as "GET /api/v1/layers".
func (s *Server) Handle(pattern string, h http.Handler) { s.mux.Handle(pattern, h) }

// HandleFunc registers fn for a ServeMux pattern.
func (s *Server) HandleFunc(pattern string, fn func(http.ResponseWriter, *http.Request)) {
	s.mux.HandleFunc(pattern, fn)
}

// Go adds background work for a mount, such as the live map's preview
// renderer. Service runs fn with its context once the routes are mounted
// and waits for it before returning; an error from fn stops the server.
// When the mounts are run directly (tests), fn isn't started.
func (s *Server) Go(fn func(ctx context.Context) error) { s.workers = append(s.workers, fn) }

// Handler returns the server's handler, with the Authorize hook applied.
// Tests can drive it with httptest.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Authorize != nil {
			if err := s.Authorize(r); err != nil {
				http.Error(w, err.Error(), http.StatusUnauthorized)
				return
			}
		}
		s.mux.ServeHTTP(w, r)
	})
}

// Mount runs the mounts against a. Service calls it; tests may call it
// directly and then use Handler.
func (s *Server) Mount(a *app.App) error {
	for _, m := range s.mounts {
		if err := m(a, s); err != nil {
			return err
		}
	}
	return nil
}

// ListenAddr returns the address the server is listening on, once it is
// (useful with ":0").
func (s *Server) ListenAddr(ctx context.Context) (net.Addr, error) {
	select {
	case a := <-s.addr:
		s.addr <- a
		return a, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Service returns an app.Service that mounts the routes and serves until
// the app stops.
func (s *Server) Service() app.Service {
	return func(ctx context.Context, a *app.App) error {
		if err := s.Mount(a); err != nil {
			return err
		}
		ln, err := net.Listen("tcp", s.Addr)
		if err != nil {
			return err
		}
		s.addr <- ln.Addr()
		ctx, cancel := context.WithCancel(ctx)
		var wg sync.WaitGroup
		werrs := make(chan error, len(s.workers))
		for _, fn := range s.workers {
			wg.Go(func() {
				if err := fn(ctx); err != nil && ctx.Err() == nil {
					werrs <- err
					cancel()
				}
			})
		}
		defer func() {
			cancel()
			wg.Wait()
		}()
		srv := &http.Server{
			Handler:           s.Handler(),
			ReadHeaderTimeout: 10 * time.Second,
			ErrorLog:          slog.NewLogLogger(a.Log.Handler(), slog.LevelWarn),
			BaseContext:       func(net.Listener) context.Context { return ctx },
		}
		a.Log.Info("http listening", "addr", ln.Addr().String())
		errc := make(chan error, 1)
		go func() { errc <- srv.Serve(ln) }()
		select {
		case err := <-errc:
			return err
		case <-ctx.Done():
		}
		sctx, scancel := context.WithTimeout(context.Background(), ShutdownTimeout)
		defer scancel()
		err = srv.Shutdown(sctx)
		if errors.Is(err, context.DeadlineExceeded) {
			err = srv.Close()
		}
		if serr := <-errc; !errors.Is(serr, http.ErrServerClosed) {
			err = errors.Join(err, serr)
		}
		select {
		case werr := <-werrs:
			err = errors.Join(werr, err)
		default:
		}
		return err
	}
}
