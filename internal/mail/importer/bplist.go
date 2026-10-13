package importer

import (
	"encoding/binary"
	"errors"
	"math"
)

// This is a small read-only binary property list (bplist00) decoder, enough to
// read the NSKeyedArchiver blobs Apple Mail stores in Accounts4.sqlite's
// ZACCOUNTPROPERTY.ZVALUE column. It is pure Go (no cgo, no Foundation) so it
// builds and runs on Linux and Windows too.

// uid is a CoreFoundation keyed-archiver reference ($objects index).
type uid uint64

type bplist struct {
	data    []byte
	offsets []int
	refSize int
}

// parseBplist decodes a bplist00 blob into Go values: map[string]any, []any,
// string, int64, float64, bool, []byte and uid.
func parseBplist(b []byte) (any, error) {
	if len(b) < 40 || string(b[:6]) != "bplist" {
		return nil, errors.New("not a binary plist")
	}
	trailer := b[len(b)-32:]
	offsetSize := int(trailer[6])
	refSize := int(trailer[7])
	numObjects := int(binary.BigEndian.Uint64(trailer[8:16]))
	topObject := int(binary.BigEndian.Uint64(trailer[16:24]))
	offsetTableStart := int(binary.BigEndian.Uint64(trailer[24:32]))
	if offsetSize <= 0 || offsetSize > 8 || numObjects < 0 {
		return nil, errors.New("bplist: bad trailer")
	}

	p := &bplist{data: b, refSize: refSize}
	p.offsets = make([]int, numObjects)
	for i := 0; i < numObjects; i++ {
		start := offsetTableStart + i*offsetSize
		if start+offsetSize > len(b) {
			return nil, errors.New("bplist: truncated offset table")
		}
		p.offsets[i] = int(readUint(b[start : start+offsetSize]))
	}
	if topObject >= numObjects {
		return nil, errors.New("bplist: bad top object")
	}
	return p.object(topObject, 0)
}

func readUint(b []byte) uint64 {
	var v uint64
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	return v
}

func (p *bplist) ref(b []byte) int { return int(readUint(b)) }

// object decodes the object at index i. depth guards against cyclic graphs.
func (p *bplist) object(i, depth int) (any, error) {
	if depth > 64 {
		return nil, errors.New("bplist: too deep")
	}
	if i < 0 || i >= len(p.offsets) {
		return nil, errors.New("bplist: ref out of range")
	}
	off := p.offsets[i]
	if off >= len(p.data) {
		return nil, errors.New("bplist: object out of range")
	}
	marker := p.data[off]
	hi, lo := marker>>4, int(marker&0x0f)
	body := p.data[off+1:]

	switch hi {
	case 0x0: // singletons
		switch lo {
		case 0x0:
			return nil, nil
		case 0x8:
			return false, nil
		case 0x9:
			return true, nil
		}
		return nil, errors.New("bplist: unknown singleton")
	case 0x1: // int, 2^lo bytes
		n := 1 << lo
		if n > len(body) {
			return nil, errors.New("bplist: truncated int")
		}
		return int64(readUint(body[:n])), nil
	case 0x2: // real
		n := 1 << lo
		if n == 4 && len(body) >= 4 {
			return float64(math.Float32frombits(uint32(readUint(body[:4])))), nil
		}
		if n == 8 && len(body) >= 8 {
			return math.Float64frombits(readUint(body[:8])), nil
		}
		return nil, errors.New("bplist: bad real")
	case 0x3: // date (8-byte real seconds since 2001); return as float64
		if len(body) >= 8 {
			return math.Float64frombits(readUint(body[:8])), nil
		}
		return nil, errors.New("bplist: bad date")
	case 0x4: // data
		n, rest, err := p.count(lo, body)
		if err != nil {
			return nil, err
		}
		if n > len(rest) {
			return nil, errors.New("bplist: truncated data")
		}
		return append([]byte(nil), rest[:n]...), nil
	case 0x5: // ASCII string
		n, rest, err := p.count(lo, body)
		if err != nil {
			return nil, err
		}
		if n > len(rest) {
			return nil, errors.New("bplist: truncated ascii")
		}
		return string(rest[:n]), nil
	case 0x6: // UTF-16BE string
		n, rest, err := p.count(lo, body)
		if err != nil {
			return nil, err
		}
		if n*2 > len(rest) {
			return nil, errors.New("bplist: truncated utf16")
		}
		u := make([]uint16, n)
		for k := 0; k < n; k++ {
			u[k] = binary.BigEndian.Uint16(rest[k*2:])
		}
		return string(utf16Decode(u)), nil
	case 0x8: // UID
		n := lo + 1
		if n > len(body) {
			return nil, errors.New("bplist: truncated uid")
		}
		return uid(readUint(body[:n])), nil
	case 0xa, 0xc: // array / set
		n, rest, err := p.count(lo, body)
		if err != nil {
			return nil, err
		}
		if n*p.refSize > len(rest) {
			return nil, errors.New("bplist: truncated array")
		}
		out := make([]any, n)
		for k := 0; k < n; k++ {
			idx := p.ref(rest[k*p.refSize : (k+1)*p.refSize])
			if out[k], err = p.object(idx, depth+1); err != nil {
				return nil, err
			}
		}
		return out, nil
	case 0xd: // dict
		n, rest, err := p.count(lo, body)
		if err != nil {
			return nil, err
		}
		if 2*n*p.refSize > len(rest) {
			return nil, errors.New("bplist: truncated dict")
		}
		keys := rest[:n*p.refSize]
		vals := rest[n*p.refSize : 2*n*p.refSize]
		out := make(map[string]any, n)
		for k := 0; k < n; k++ {
			kobj, err := p.object(p.ref(keys[k*p.refSize:(k+1)*p.refSize]), depth+1)
			if err != nil {
				return nil, err
			}
			vobj, err := p.object(p.ref(vals[k*p.refSize:(k+1)*p.refSize]), depth+1)
			if err != nil {
				return nil, err
			}
			ks, _ := kobj.(string)
			out[ks] = vobj
		}
		return out, nil
	}
	return nil, errors.New("bplist: unknown marker")
}

// count reads a collection/string length: lo, or an int object when lo==0xf.
func (p *bplist) count(lo int, body []byte) (int, []byte, error) {
	if lo != 0x0f {
		return lo, body, nil
	}
	if len(body) < 1 {
		return 0, nil, errors.New("bplist: bad count")
	}
	sizeMarker := body[0]
	if sizeMarker>>4 != 0x1 {
		return 0, nil, errors.New("bplist: bad count marker")
	}
	n := 1 << int(sizeMarker&0x0f)
	if 1+n > len(body) {
		return 0, nil, errors.New("bplist: truncated count")
	}
	return int(readUint(body[1 : 1+n])), body[1+n:], nil
}

func utf16Decode(u []uint16) []rune {
	out := make([]rune, 0, len(u))
	for i := 0; i < len(u); i++ {
		r := rune(u[i])
		if r >= 0xd800 && r <= 0xdbff && i+1 < len(u) {
			r2 := rune(u[i+1])
			if r2 >= 0xdc00 && r2 <= 0xdfff {
				out = append(out, ((r-0xd800)<<10|(r2-0xdc00))+0x10000)
				i++
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// unarchive resolves an NSKeyedArchiver graph to plain Go values, like
// Foundation's unarchiver: UIDs are followed into $objects, NS.string is the
// string, NS.keys/NS.objects become a map, NS.objects alone becomes a slice.
func unarchive(root any) (any, error) {
	top, ok := root.(map[string]any)
	if !ok {
		return nil, errors.New("bplist: not a keyed archive")
	}
	objects, ok := top["$objects"].([]any)
	if !ok {
		return nil, errors.New("bplist: no $objects")
	}
	topDict, ok := top["$top"].(map[string]any)
	if !ok {
		return nil, errors.New("bplist: no $top")
	}
	var resolve func(v any, depth int) any
	resolve = func(v any, depth int) any {
		if depth > 64 {
			return nil
		}
		switch t := v.(type) {
		case uid:
			if int(t) < 0 || int(t) >= len(objects) {
				return nil
			}
			return resolve(objects[t], depth+1)
		case map[string]any:
			if s, ok := t["NS.string"]; ok {
				return s
			}
			if keys, ok := t["NS.keys"].([]any); ok {
				vals, _ := t["NS.objects"].([]any)
				m := map[string]any{}
				for i := range keys {
					ks, _ := resolve(keys[i], depth+1).(string)
					if i < len(vals) {
						m[ks] = resolve(vals[i], depth+1)
					}
				}
				return m
			}
			if objs, ok := t["NS.objects"].([]any); ok {
				out := make([]any, len(objs))
				for i := range objs {
					out[i] = resolve(objs[i], depth+1)
				}
				return out
			}
			out := map[string]any{}
			for k, val := range t {
				if k == "$class" {
					continue
				}
				out[k] = resolve(val, depth+1)
			}
			return out
		default:
			return v
		}
	}
	return resolve(topDict["root"], 0), nil
}
