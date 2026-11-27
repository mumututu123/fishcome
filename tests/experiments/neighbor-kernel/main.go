package main

import (
	"cmp"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"time"
)

const width = 1000
const columns = 100
const epsilon = 2.220446049250313e-16 * width * 4

type point struct {
	x, y        float64
	rank, index int
}
type frame struct{ points, scenes []point }
type adjacency struct{ offsets, indices []uint32 }

func newOutput(n int) adjacency { return adjacency{make([]uint32, n+1), make([]uint32, 0, n*32)} }
func bin(v float64) int         { return int(math.Floor(v / 10)) }
func col(v int) int             { return (v + columns) % columns }

// Points are normalized to [0,1000). Match both modulo roundings of production deltaX.
func delta(a, b float64) float64 {
	d := a - b + 500
	if d >= 1000 {
		d -= 1000
	}
	d += 1000
	if d >= 2000 {
		d -= 2000
	} else if d >= 1000 {
		d -= 1000
	}
	return d - 500
}
func rowRound(x float64) int {
	f := math.Floor(x)
	if x-f >= 0.5 {
		return int(f) + 1
	}
	return int(f)
}

type sight struct {
	bins map[int]bool
	rows map[int][]byte
}

func makeSight(scenes []point) sight {
	s := sight{map[int]bool{}, map[int][]byte{}}
	for _, p := range scenes {
		s.bins[bin(p.y)*columns+bin(p.x)] = true
		x, y := int(p.x), int(p.y)
		if float64(x) == p.x && float64(y) == p.y {
			if s.rows[y] == nil {
				s.rows[y] = make([]byte, width)
			}
			s.rows[y][x] = 1
		}
	}
	return s
}
func (s sight) near(x, y float64) bool {
	if len(s.bins) == 0 {
		return false
	}
	const e = 16 + epsilon
	for bx := bin(x - e); bx <= bin(x+e); bx++ {
		for by := bin(y - e); by <= bin(y+e); by++ {
			if s.bins[by*columns+col(bx)] {
				return true
			}
		}
	}
	return false
}
func (s sight) clear(x, y, dx, dy float64) bool {
	steps := int(math.Ceil(math.Max(math.Abs(dx), math.Abs(dy))))
	for k := 1; k < steps; k++ {
		row := s.rows[rowRound(y+dy*float64(k)/float64(steps))]
		if row == nil {
			continue
		}
		c := rowRound(x + dx*float64(k)/float64(steps))
		if c < 0 {
			c += width
		} else if c >= width {
			c -= width
		}
		if row[c] != 0 {
			return false
		}
	}
	return true
}

const e = 12 + epsilon

func objects(f frame) adjacency {
	bins := map[int][]*point{}
	s := makeSight(f.scenes)
	out := newOutput(len(f.points))
	for i := range f.points {
		p := &f.points[i]
		k := bin(p.y)*columns + bin(p.x)
		bins[k] = append(bins[k], p)
	}
	type hit struct {
		q        *point
		distance float64
	}
	for i := range f.points {
		p := &f.points[i]
		obstacles := s.near(p.x, p.y)
		var hits []hit
		for bx := bin(p.x - e); bx <= bin(p.x+e); bx++ {
			for by := bin(p.y - e); by <= bin(p.y+e); by++ {
				for _, q := range bins[by*columns+col(bx)] {
					if p == q {
						continue
					}
					d := math.Max(math.Abs(delta(p.x, q.x)), math.Abs(p.y-q.y))
					if d <= 12 && (!obstacles || s.clear(p.x, p.y, delta(q.x, p.x), q.y-p.y)) {
						hits = append(hits, hit{q, d})
					}
				}
			}
		}
		slices.SortStableFunc(hits, func(a, b hit) int {
			if c := cmp.Compare(a.distance, b.distance); c != 0 {
				return c
			}
			return cmp.Compare(a.q.rank, b.q.rank)
		})
		for _, h := range hits {
			out.indices = append(out.indices, uint32(h.q.index))
		}
		out.offsets[i+1] = uint32(len(out.indices))
	}
	return out
}
func flat(f frame, integerSort bool) adjacency {
	n := len(f.points)
	xs, ys := make([]float64, n), make([]float64, n)
	ranks := make([]int, n)
	var byRank []int
	stride := 1
	for stride < n {
		stride *= 2
	}
	if integerSort {
		byRank = make([]int, n)
		for i := range byRank {
			byRank[i] = -1
		}
	}
	s := makeSight(f.scenes)
	out := newOutput(n)
	minRow, maxRow := bin(f.points[0].y), bin(f.points[0].y)
	for i, p := range f.points {
		xs[i], ys[i], ranks[i] = p.x, p.y, p.rank
		if integerSort {
			if p.rank >= n || byRank[p.rank] != -1 || math.Trunc(2*p.x) != 2*p.x || math.Trunc(2*p.y) != 2*p.y {
				integerSort = false
			} else {
				byRank[p.rank] = i
			}
		}
		row := bin(p.y)
		minRow = min(minRow, row)
		maxRow = max(maxRow, row)
	}
	head, next := make([]int, (maxRow-minRow+1)*columns), make([]int, n)
	for i := range head {
		head[i] = -1
	}
	for i := n - 1; i >= 0; i-- {
		k := (bin(ys[i])-minRow)*columns + bin(xs[i])
		next[i], head[k] = head[k], i
	}
	hits, distances := make([]int, 0, n), make([]float64, n)
	for i, x := range xs {
		y := ys[i]
		obstacles := s.near(x, y)
		hits = hits[:0]
		first, last := max(minRow, bin(y-e)), min(maxRow, bin(y+e))
		for bx := bin(x - e); bx <= bin(x+e); bx++ {
			for by := first; by <= last; by++ {
				for j := head[(by-minRow)*columns+col(bx)]; j != -1; j = next[j] {
					if i == j {
						continue
					}
					d := math.Max(math.Abs(delta(x, xs[j])), math.Abs(y-ys[j]))
					if d > 12 || (obstacles && !s.clear(x, y, delta(xs[j], x), ys[j]-y)) {
						continue
					}
					if integerSort {
						hits = append(hits, int(d*2)*stride+ranks[j])
					} else {
						hits = append(hits, j)
						distances[j] = d
					}
				}
			}
		}
		if integerSort {
			slices.Sort(hits)
			for _, key := range hits {
				out.indices = append(out.indices, uint32(byRank[key&(stride-1)]))
			}
		} else {
			slices.SortStableFunc(hits, func(a, b int) int {
				if c := cmp.Compare(distances[a], distances[b]); c != 0 {
					return c
				}
				return cmp.Compare(ranks[a], ranks[b])
			})
			for _, j := range hits {
				out.indices = append(out.indices, uint32(j))
			}
		}
		out.offsets[i+1] = uint32(len(out.indices))
	}
	return out
}

func decode(b []byte) (frame, error) {
	var f frame
	if len(b) < 8 {
		return f, fmt.Errorf("missing counts")
	}
	u := binary.LittleEndian
	n, m := int(u.Uint32(b)), int(u.Uint32(b[4:]))
	if n < 1 || n > 10000 || m > 100000 || len(b) != 8+20*n+16*m {
		return f, fmt.Errorf("invalid counts")
	}
	f = frame{make([]point, n), make([]point, m)}
	k := 8
	for groupIndex, group := range [][]point{f.points, f.scenes} {
		for i := range group {
			p := &group[i]
			p.x = math.Float64frombits(u.Uint64(b[k:]))
			p.y = math.Float64frombits(u.Uint64(b[k+8:]))
			k += 16
			if !(p.x >= 0 && p.x < width && p.y >= -1000 && p.y <= 1000) {
				return f, fmt.Errorf("invalid coordinates")
			}
			if groupIndex == 0 {
				p.rank = int(u.Uint32(b[k:]))
				p.index = i
				k += 4
			}
		}
	}
	return f, nil
}
func serveKernel(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.Header.Get("Content-Type") != "application/octet-stream" {
		http.Error(w, "binary POST required", 400)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		http.Error(w, "invalid frame", 400)
		return
	}
	f, err := decode(data)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	var out adjacency
	at := time.Now()
	switch r.URL.Path {
	case "/objects":
		out = objects(f)
	case "/flat", "/integer":
		out = flat(f, r.URL.Path == "/integer")
	default:
		http.NotFound(w, r)
		return
	}
	elapsed := time.Since(at)
	b := make([]byte, 0, 4*(len(out.offsets)+len(out.indices)))
	for _, list := range [][]uint32{out.offsets, out.indices} {
		for _, v := range list {
			b = binary.LittleEndian.AppendUint32(b, v)
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Kernel-Ns", strconv.FormatInt(elapsed.Nanoseconds(), 10))
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

func main() {
	if len(os.Args) != 3 {
		panic("expected repository www and experiment directories")
	}
	files := regexp.MustCompile(`^/[a-z0-9-]+\.js$`)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<!doctype html><title>Neighbor experiment</title>")
		case "/kernel.mjs", "/measure.mjs":
			w.Header().Set("Content-Type", "text/javascript")
			http.ServeFile(w, r, filepath.Join(os.Args[2], r.URL.Path[1:]))
		case "/objects", "/flat", "/integer":
			serveKernel(w, r)
		default:
			if !files.MatchString(r.URL.Path) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/javascript")
			http.ServeFile(w, r, filepath.Join(os.Args[1], r.URL.Path[1:]))
		}
	})
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Printf("http://%s %s\n", l.Addr(), runtime.Version())
	if err = http.Serve(l, nil); err != nil {
		panic(err)
	}
}
