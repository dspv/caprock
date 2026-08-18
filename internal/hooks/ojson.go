package hooks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// Ordered JSON: settings.json belongs to the user, so a merge must not reorder
// their keys. encoding/json maps sort keys; this tiny model keeps insertion order.

// Object is a JSON object with stable key order.
type Object struct {
	Keys   []string
	Values map[string]any // values are: *Object, []any, string, float64, bool, nil
}

// NewObject creates an empty ordered object.
func NewObject() *Object { return &Object{Values: map[string]any{}} }

// Get returns a value and whether it exists.
func (o *Object) Get(k string) (any, bool) { v, ok := o.Values[k]; return v, ok }

// Set inserts or replaces a value, appending new keys at the end.
func (o *Object) Set(k string, v any) {
	if _, ok := o.Values[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.Values[k] = v
}

// Delete removes a key.
func (o *Object) Delete(k string) {
	if _, ok := o.Values[k]; !ok {
		return
	}
	delete(o.Values, k)
	for i, kk := range o.Keys {
		if kk == k {
			o.Keys = append(o.Keys[:i], o.Keys[i+1:]...)
			break
		}
	}
}

// Len returns the number of keys.
func (o *Object) Len() int { return len(o.Keys) }

// MarshalJSON writes keys in insertion order.
func (o *Object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.Keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		vb, err := json.Marshal(o.Values[k])
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// ParseOrdered decodes JSON preserving object key order.
func ParseOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	// Reject trailing garbage.
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing data after JSON value")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := NewObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string: %v", kt)
				}
				val, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, val)
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				val, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, val)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return arr, nil
		default:
			return nil, fmt.Errorf("unexpected delimiter %v", t)
		}
	default:
		return tok, nil // string, json.Number, bool, nil
	}
}

// MarshalIndent renders an ordered value with 2-space indentation, matching
// how Claude Code writes settings.json.
func MarshalIndent(v any) ([]byte, error) {
	compact, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, compact, "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}
