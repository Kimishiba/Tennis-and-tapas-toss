# AI Agent Collaboration & Contributors

This repository is co-developed, maintained, and extended by multiple instances of AI coding agents working in collaboration with human developers. 

## Overview

To facilitate seamless development, coordinate tasks, and prevent conflicts between different agent runs, this project utilizes a structured agent-collaboration framework. Multiple AI agent instances may be spawned to handle different subtasks concurrently or sequentially.

## Active Agents & Roles

Depending on the workspace context and development tasks, the following agent types/instances are typically active:

*   **Lead Agent (Antigravity)**: Coordinates the overall development plan, interacts with the user, structures task workflows, and integrates components.
*   **Research Agent (`research`)**: A read-only specialist dedicated to broad codebase analysis, dependency audits, external API lookups, and developer documentation reviews.
*   **Subagent/Self Agent (`self`)**: Subagents spawned to handle isolated, parallel tasks in branched or shared workspaces (e.g., writing tests, setting up containerization, refactoring specific modules).
*   **API Documenter Agent (`api-documenter`)**: Specializes in creating and updating OpenAPI specifications, developer portals, SDK docs, and API-related integration/migration workflows.

## Coordination & Best Practices

To ensure agent coordination across multiple runs and environments:

1.  **Planning Mode & Artifacts**:
    *   Agents use `/Users/alessandro.longoni/.gemini/antigravity/brain/<conversation-id>/implementation_plan.md` to propose architectural changes before execution.
    *   `task.md` is updated dynamically to keep track of active, pending, and completed tasks.
    *   `walkthrough.md` is generated upon task completion to summarize the implementation and verification details.
2.  **Git Workflows**:
    *   Agents should commit modularly and write descriptive, standard commit messages.
    *   When working on complex, parallel features, agents should use distinct topic branches to avoid merge conflicts.
3.  **Conflict Prevention**:
    *   Before starting any major changes, agents must pull the latest changes from the remote repository and verify local file states.
    *   Always run verification/test suites locally (`npm test`) before pushing changes to ensure main branch stability.
