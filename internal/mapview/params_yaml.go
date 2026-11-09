// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package mapview

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"gopkg.in/yaml.v3"
)

const maxParamsBody = 1 << 20

// handleParamsYAML turns a layer's params, sent as JSON, into YAML.
func (m *Map) handleParamsYAML(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxParamsBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, "reading settings: %v", err)
		return
	}
	text, err := paramsToYAML(body)
	if err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, map[string]string{"yaml": text})
}

// handleParamsJSON reads YAML a person wrote and answers with the params.
func (m *Map) handleParamsJSON(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxParamsBody))
	if err != nil {
		httpError(w, http.StatusBadRequest, "reading settings: %v", err)
		return
	}
	params, err := paramsFromYAML(body)
	if err != nil {
		httpError(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, params)
}

func paramsToYAML(body []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber() // a float64 would come out as 1e+06
	var params map[string]any
	if err := dec.Decode(&params); err != nil {
		return "", fmt.Errorf("settings aren't valid JSON: %w", err)
	}
	if len(params) == 0 {
		return "", nil
	}
	out, err := yaml.Marshal(plainNumbers(params))
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// plainNumbers replaces each json.Number with an int or a float, since
// YAML would otherwise write it as a quoted string.
func plainNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		if f, err := x.Float64(); err == nil {
			return f
		}
		return x.String()
	case map[string]any:
		for k, e := range x {
			x[k] = plainNumbers(e)
		}
	case []any:
		for i, e := range x {
			x[i] = plainNumbers(e)
		}
	}
	return v
}

func paramsFromYAML(text []byte) (map[string]any, error) {
	dec := yaml.NewDecoder(bytes.NewReader(text))
	var root any
	if err := dec.Decode(&root); err != nil {
		if errors.Is(err, io.EOF) {
			return map[string]any{}, nil
		}
		return nil, yamlError(err)
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, errors.New("write one set of settings, without a --- separator")
	}
	if root == nil {
		return map[string]any{}, nil
	}
	if _, ok := root.(map[any]any); ok {
		return nil, errors.New("setting names must be words")
	}
	params, ok := root.(map[string]any)
	if !ok {
		return nil, errors.New("write the settings as name: value lines")
	}
	if err := checkValues("", params); err != nil {
		return nil, err
	}
	// Dates and the like must survive the trip back as JSON.
	if _, err := json.Marshal(params); err != nil {
		return nil, fmt.Errorf("a value can't be used: %w", err)
	}
	return params, nil
}

func yamlError(err error) error {
	return errors.New(strings.TrimPrefix(err.Error(), "yaml: "))
}

// checkValues rejects empty values and maps that aren't keyed by words.
// An empty value is usually an unquoted color: YAML reads everything
// after a # as a comment.
func checkValues(path string, v any) error {
	switch x := v.(type) {
	case nil:
		return fmt.Errorf("%s has no value; if it's a color, put it in quotes, like \"#ff0000\"", path)
	case map[string]any:
		for k, e := range x {
			p := k
			if path != "" {
				p = path + "." + k
			}
			if err := checkValues(p, e); err != nil {
				return err
			}
		}
	case map[any]any:
		return fmt.Errorf("%s: setting names must be words", path)
	case []any:
		for i, e := range x {
			if err := checkValues(fmt.Sprintf("%s[%d]", path, i), e); err != nil {
				return err
			}
		}
	}
	return nil
}
