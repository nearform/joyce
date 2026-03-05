# WebMCP Integration Ideas for Joyce

## Overview

WebMCP (Web Model Context Protocol) is a new standard for exposing website functionality as tools for AI agents. It creates a direct communication channel between websites and AI systems through structured interfaces (tools, prompts, resources) instead of relying on UI automation. Given that Joyce is a sophisticated RAG-powered knowledge assistant with in-browser LLMs and rich search capabilities, WebMCP could unlock powerful agent integration patterns while maintaining the no-backend architecture.

---

## Key Findings

1. **WebMCP Architecture**: WebMCP provides a JavaScript widget that websites embed via a single script tag. It exposes four core capabilities:
   - **Tools**: Execute JavaScript functions with structured input/output schemas that agents can call
   - **Prompts**: Reusable, parameterized query templates for consistent agent interactions
   - **Resources**: URI-based data exposure supporting text and binary formats
   - **Sampling**: Request LLM completions while maintaining user control via modal dialogs

2. **Joyce's Current Strengths for WebMCP Integration**:
   - Already manages multiple LLM providers (Web-LLM for WebGPU, Chrome built-in Gemini Nano)
   - Sophisticated RAG pipeline with vector + full-text search on posts data
   - Orama database layer enabling structured queries
   - Token estimation and context budgeting (already handles token limits for multi-turn)
   - Pre-computed embeddings (quantized uint8, dequantized at runtime)
   - Pure client-side processing with no backend dependency

3. **Core Use Case Fit**: Joyce's knowledge domain and existing search/context infrastructure make it ideal for exposing structured tools to AI agents. Agents could query Nearform content knowledge in a reliable, schema-driven way rather than trying to parse UI.

4. **Implementation Compatibility**: WebMCP is entirely browser-based JavaScript, aligning perfectly with Joyce's no-build, pure-JS architecture. No backend server required—just a client-side registration layer on top of existing APIs.

5. **Chrome Pilot Program Integration**: WebMCP is currently available via an early preview program. Chrome Desktop (and others) can connect to WebMCP-enabled sites, enabling real-world agent workflows immediately upon implementation.

---

## High-Level Implementation Ideas

1. **Expose Search Tools**: Register WebMCP tools wrapping `performRagSearch()` and `search()` with structured parameters (query, filters by postType/date/category). Agents could reliably query the knowledge base without UI interaction, with automatic context building and token budgeting. Ideal for: "Find Nearform's thoughts on microservices" or filtered searches.

2. **Export Chat Context as Resources**: Expose the built context (XML chunks with links, metadata) as WebMCP resources with URI schemes like `webmcp://joyce/context/{sessionId}`. Allows agents to reference and work with the structured context that Joyce builds, enabling multi-agent collaboration where one agent queries, another analyzes results.

3. **Post Metadata & Relations Tool**: Register a tool to retrieve post details with full content, related posts by category, author info, and publication metadata. Agents could navigate the knowledge graph systematically. Pairs with Sampling to request LLM summaries of posts while keeping the user in the loop.

4. **Prompt Templates for Common Queries**: Define WebMCP prompts for recurring agent workflows: "Find all posts by author X", "List posts in category Y from date range Z", "Summarize Nearform's stance on [topic]". Pre-baked with Joyce's schema knowledge, reducing agent reasoning overhead and improving reliability.

5. **Token Budget & Context Negotiation Tool**: Expose `reduceContext()` and token estimation as WebMCP tools so agents can adaptively negotiate context size within LLM token budgets. Enables multi-turn sessions where agents can request more/less context, handle model switches (Web-LLM <-> Chrome Gemini), and gracefully degrade when approaching limits.

---

## Best Practices

- **Schema First**: Define WebMCP tool schemas precisely (required/optional params, enum constraints, return types). Joyce's existing type/filter system (postType, categoryPrimary, minDate) map directly to schema fields.
- **Preserve User Agency**: Use Sampling for any non-deterministic operations (LLM summarization, classification). Keep modal dialogs visible so users see what agents are requesting.
- **Leverage Existing Caching**: WebMCP tools should use `getAndCache` pattern from `shared-util.js` for embeddings, databases, and extractor pipelines—they're already optimized for repeated calls.
- **Version Resources**: URIs for exposed data (contexts, posts) should include version/session identifiers to prevent stale references across agent calls.
- **Test with MCP Clients**: Use Claude Desktop or Verge MCP client in preview to validate tool usability and schema clarity before production release.

---

## Code Examples

WebMCP tool registration pattern (simplified for Joyce):

```javascript
// In a new file: public/local/data/api/webmcp.js
import { performRagSearch } from "./rag.js";
import { getPost } from "./posts.js";

export const registerWebMcpTools = () => {
  // Tool 1: Search
  window.webmcp?.registerTool({
    name: "search_nearform_knowledge",
    description:
      "Search Nearform knowledge base with vector + full-text search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        postType: {
          type: "array",
          items: { type: "string" },
          enum: ["blog", "case-study", "video"],
          description: "Filter by post type",
        },
        minDate: {
          type: "string",
          format: "date",
          description: "Minimum publication date (ISO 8601)",
        },
      },
      required: ["query"],
    },
    handler: async (input) => {
      const { searchData, contextState } = await performRagSearch({
        query: input.query,
        filters: {
          postType: input.postType || [],
          minDate: input.minDate || "",
          categoryPrimary: [],
        },
        provider: "webllm",
        model: "default",
        supportsMultiTurn: true,
      });
      return {
        posts: searchData.displayPosts,
        context: contextState.context,
        chunkCount: contextState.chunkCount,
      };
    },
  });

  // Tool 2: Get post by ID
  window.webmcp?.registerTool({
    name: "get_post_details",
    description: "Retrieve full post details by ID",
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string" },
      },
      required: ["postId"],
    },
    handler: async (input) => {
      const post = await getPost(input.postId);
      return post || { error: "Post not found" };
    },
  });
};
```

Registration in `public/index.html` alongside React init:

```html
<script type="module">
  // ... existing React init ...

  // Load WebMCP if available
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/webmcp@latest"; // TBD version
  script.onload = async () => {
    const { registerWebMcpTools } = await import("./local/data/api/webmcp.js");
    registerWebMcpTools();
  };
  document.head.appendChild(script);
</script>
```

---

## Pitfalls

- **Schema Drift**: Keeping WebMCP tool schemas synchronized with underlying Joyce APIs (rag.js, search.js, posts.js). Use JSDoc + tool generator or automated validation.
- **Token Limits**: Agents may request large context windows. WebMCP tools should validate and reject or gracefully reduce context (leverage existing `reduceContext()`) rather than silently truncating.
- **Session State Leakage**: If resources expose session IDs, ensure they're properly scoped and invalidated. Agents connecting across sessions shouldn't access other users' cached contexts.
- **Privacy / Data Exposure**: Nearform's proprietary embeddings and posts data would be queryable by any connected agent. Clarify if this is intended (internal only vs. public) and gate accordingly.
- **Embedding Backend Dependency Illusion**: Even though Joyce is no-backend, embeddings were pre-computed server-side. WebMCP doesn't change that; it only exposes the already-available embeddings. Don't conflate "client-side LLM" with "fully offline deployment."

---

## Sources

- [Chrome Developer Blog: Introducing WebMCP](https://developer.chrome.com/blog/webmcp-epp) — Overview of WebMCP, use cases (e-commerce, support, travel), architecture, and early preview program
- [WebMCP Official Documentation](https://webmcp.dev/) — Core concepts (tools, prompts, resources, sampling), architecture, and implementation patterns
- [WebMCP GitHub Repository](https://github.com/webmachinelearning/webmcp) — Source, examples, and specification details
- Joyce CLAUDE.md — Project architecture, data layer design, LLM providers, RAG pipeline, no-build constraints

---

## Next Steps

1. **Prototype Phase**: Create a minimal WebMCP integration (`public/local/data/api/webmcp.js`) with 1-2 tools (search + post retrieval) and test with Claude Desktop's MCP client.
2. **Schema Definition**: Document all tool schemas formally (JSON Schema) and cross-validate with existing API signatures to catch breaking mismatches.
3. **Resource Endpoints**: Define URIs for exposed contexts and posts (e.g., `webmcp://joyce/search/[sessionId]`) with versioning and TTL.
4. **Sampling Workflows**: Identify which operations should use Sampling (e.g., "summarize this post") to ensure user visibility and consent.
5. **Deployment & Documentation**: Update CLAUDE.md with WebMCP setup instructions, add to GitHub Pages build, and provide agent integration examples for users/partners.
