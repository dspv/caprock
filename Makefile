# Caprock — build, test, docs, and release targets.
#
# Go module lives at the repo root; the dashboard lives in ui/ and is embedded into
# the binary from internal/api/dist (built by `make ui`).

DOCS := $(shell find . -name '*.md' \
          -not -path './node_modules/*' -not -path './.git/*' \
          -not -path './vendor/*' -not -path './ui/node_modules/*' \
          -not -path './ui/dist/*' | sort)

BIN      := bin
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  := -s -w -X github.com/dspv/caprock/internal/version.Version=$(VERSION)
GOFLAGS  := -trimpath
export CGO_ENABLED = 0

.DEFAULT_GOAL := help

# --- help -----------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- build ----------------------------------------------------------------
.PHONY: build
build: ui ## Build ./bin/caprock and ./bin/caprock-hook (with the embedded UI)
	@mkdir -p $(BIN)
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN)/caprock ./cmd/caprock
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN)/caprock-hook ./cmd/caprock-hook

.PHONY: build-go
build-go: ## Build the Go binaries only (uses whatever UI is already embedded)
	@mkdir -p $(BIN)
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN)/caprock ./cmd/caprock
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN)/caprock-hook ./cmd/caprock-hook

.PHONY: ui
ui: ## Build the dashboard into internal/api/dist (installs deps on a fresh clone)
	cd ui && [ -d node_modules ] || npm ci
	cd ui && npm run build

.PHONY: dist-check
dist-check: ui ## Fail if the committed internal/api/dist/ is stale vs a fresh build (CI gate for `go install`)
	@git status --porcelain --untracked-files=all -- internal/api/dist \
		| grep -vE '^[MARD] ' | grep -q . && { \
		echo "internal/api/dist/ is out of date — run 'make ui' and commit the result"; \
		git --no-pager status --short -- internal/api/dist; exit 1; } || true
	@echo "dist is in sync with ui/"

.PHONY: ui-install
ui-install: ## npm ci for the dashboard
	cd ui && npm ci

.PHONY: dev
dev: ## Run daemon (go run) + vite dev server; UI on :5173 proxies API to :4173
	@./scripts/dev.sh

# --- test / lint ----------------------------------------------------------
.PHONY: test
test: test-go test-ui ## All tests

.PHONY: test-go
test-go: ## Go tests
	go test ./...

.PHONY: test-ui
test-ui: ## Dashboard tests
	cd ui && npm test -- --run

.PHONY: lint
lint: lint-go lint-ui ## All linters

.PHONY: lint-go
lint-go: ## go vet + golangci-lint
	go vet ./...
	golangci-lint run

.PHONY: lint-ui
lint-ui: ## tsc --noEmit
	cd ui && npm run typecheck

.PHONY: smoke
smoke: build-go ## Phase 0 DoD scenario + the Phase 2 e2e (what CI's smoke step runs)
	go test -tags smoke -count=1 ./internal/smoke/... ./internal/board/...

# --- docs -----------------------------------------------------------------
.PHONY: docs-fmt
docs-fmt: ## Tight-align all markdown tables (run after editing any table)
	@python3 scripts/align-tables.py $(DOCS)

.PHONY: docs-check
docs-check: ## Fail if any markdown table is unaligned (CI gate)
	@python3 scripts/align-tables.py --check $(DOCS)

.PHONY: docs-links
docs-links: ## Fail if any relative markdown link does not resolve
	@python3 scripts/check-links.py $(DOCS)

.PHONY: check
check: docs-check docs-links lint test dist-check smoke ## Docs gates + lint + test + dist sync + smoke (what CI runs, minus the OS matrix)

.PHONY: shots
shots: ## Re-take the documented screenshots and open a PR (needs a real database)
	@bash scripts/refresh-shots.sh

.PHONY: reload
reload: build ## Build the dashboard + binaries and restart the running daemon on this machine
	@# Runs ./bin/caprock rather than installing over the copy on PATH.
	@#
	@# It used to `install` over whatever `command -v caprock` found, which on a
	@# Homebrew machine replaces brew's symlink with a plain file: `brew upgrade`
	@# then reports success while PATH still resolves to the dev build, and the
	@# next `brew doctor` complains. Exactly the breakage the update dialog warns
	@# about, caused by our own dev loop. Recovering meant `brew link --overwrite`.
	@$(BIN)/caprock down >/dev/null 2>&1 || true
	@$(BIN)/caprock up --no-open >/dev/null 2>&1 || true
	@echo "reloaded → $$($(BIN)/caprock --version) (from ./bin; the copy on PATH is untouched)"
