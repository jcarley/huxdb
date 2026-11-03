.PHONY: help up down status stop provision provision-check users users-env-check dev test

.DEFAULT_GOAL := help

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Start all services in the background
	@docker compose up -d

down: ## Stop and remove containers, volumes, and locally built images
	@docker compose down -v --rmi local

status: ## Show the status of running services
	@docker compose ps

stop: ## Stop running services without removing them
	@docker compose stop

dev: ## starts the development server
	@npm run tauri dev
