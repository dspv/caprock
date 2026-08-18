# [Project] — build, docs, and deploy targets.
#
# Corpus ships only the docs targets. Add build/test/deploy targets as the tracks in
# .ai/14-build-status.md move off 0%.

# Every markdown file in the repo, excluding vendored trees. Tables anywhere --
# including READMEs next to code -- are held to the same alignment rule.
DOCS := $(shell find . -name '*.md' \
          -not -path './node_modules/*' -not -path './.git/*' \
          -not -path './vendor/*' -not -path './.next/*' \
          | sort)

.DEFAULT_GOAL := help

# --- help -----------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

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
check: docs-check docs-links ## Everything CI runs
