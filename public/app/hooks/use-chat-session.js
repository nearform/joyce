import { useState, useEffect, useRef } from "react";
import { getElements, getQuerySetter } from "../util/html.js";
import { createChatSession, getProviderCapabilities } from "../data/index.js";
import { FEATURES } from "../../config.js";
import { isContextExceededError } from "../components/context-messages.js";
import { buildQueryInfo } from "../util/query-info-builder.js";

const setQueryValue = getQuerySetter("query");

/**
 * Custom hook for managing chat session state and business logic.
 *
 * Encapsulates all conversation state, RAG context, form state, and
 * interaction handlers. Provides a clean API for the Chat component.
 *
 * @param {Object} options
 * @param {Object} options.modelObj - Current model configuration
 * @param {number} options.temperature - Sampling temperature
 * @param {string} options.minDate - Minimum post date filter
 * @param {Array} options.selectedPostTypes - Selected post type filters
 * @param {Array} options.selectedCategoryPrimary - Selected category filters
 * @param {boolean} options.isModelLoaded - Whether the current model is loaded
 * @param {Function} options.startLoading - Callback to start model loading
 * @param {Function} options.getError - Callback to get model loading error
 * @returns {Object} Chat session state and handlers
 */
export const useChatSession = ({
  modelObj,
  temperature,
  minDate,
  selectedPostTypes,
  selectedCategoryPrimary,
  isModelLoaded,
  startLoading,
  getError,
  modelResourceId,
  modelStatus,
}) => {
  // ============================================================================
  // State Management
  // ============================================================================

  // Conversation state - array of Q&A entries
  const [conversation, setConversation] = useState([]);
  const [isFetching, setIsFetching] = useState(false);

  // RAG context - only fetched on first question, persists until reset
  const [posts, setPosts] = useState(null);
  const [searchData, setSearchData] = useState(null);
  const [analyticsDates, setAnalyticsDates] = useState({
    start: null,
    end: null,
  });

  // Error state
  const [err, setErr] = useState(null);
  const [contextExceededErr, setContextExceededErr] = useState(null);

  // Refs
  const pendingQueryRef = useRef(null);
  const chatSessionRef = useRef(null);

  // Track when we're waiting for model to load before chat
  const [isLoadingModelForChat, setIsLoadingModelForChat] = useState(false);

  // ============================================================================
  // Derived State
  // ============================================================================

  const isConversationActive = conversation.length > 0;
  const hasCompletions = conversation.some((entry) => entry.answer);

  // Check if current model supports multi-turn conversations
  const capabilities = chatSessionRef.current
    ? chatSessionRef.current.getCapabilities()
    : getProviderCapabilities(modelObj.provider, modelObj.model);
  const modelSupportsMultiTurn = capabilities.supportsMultiTurn;

  // Check if model changed since current session was created
  const sessionModel = chatSessionRef.current?.getModel();
  const modelChanged = sessionModel && sessionModel.model !== modelObj.model;

  // Conversations enabled if: feature flag + model supports + model unchanged
  const conversationsEnabled =
    FEATURES.chat.conversations && modelSupportsMultiTurn && !modelChanged;

  // Form inputs locked when conversation active AND conversations enabled
  const formInputsLocked = isConversationActive && conversationsEnabled;

  // Placeholder text based on conversation state
  const placeholder = isConversationActive
    ? conversationsEnabled
      ? "Ask a follow-up question..."
      : "Ask a new question..."
    : "Ask anything";

  // ============================================================================
  // Conversation State Helpers
  // ============================================================================

  /**
   * Reset all outputs for a new conversation.
   */
  const resetForNewConversation = () => {
    setQueryValue("");
    setConversation([]);
    setPosts(null);
    setSearchData(null);
    setAnalyticsDates({ start: null, end: null });
    setErr(null);
    setContextExceededErr(null);
    // Clean up chat session
    if (chatSessionRef.current) {
      chatSessionRef.current.destroy();
      chatSessionRef.current = null;
    }
  };

  /**
   * Transform the last conversation entry using a callback.
   */
  const modifyLastEntry = (transformFn) => {
    setConversation((prev) => {
      const updated = [...prev];
      const lastIdx = updated.length - 1;
      if (lastIdx >= 0) {
        updated[lastIdx] = transformFn(updated[lastIdx]);
      }
      return updated;
    });
  };

  /**
   * Update the last conversation entry with merged properties.
   */
  const updateLastEntry = (updates) =>
    modifyLastEntry((entry) => ({ ...entry, ...updates }));

  /**
   * Append text to the last conversation entry's answer (for streaming).
   */
  const appendToLastAnswer = (text) =>
    modifyLastEntry((entry) => ({
      ...entry,
      answer: (entry.answer ?? "") + text,
    }));

  /**
   * Create a new loading conversation entry.
   */
  const createLoadingEntry = (query) => ({
    query,
    answer: null,
    queryInfo: null,
    isLoading: true,
  });

  /**
   * Handle chat errors consistently.
   */
  const handleChatError = (respErr) => {
    console.error(respErr); // eslint-disable-line no-undef
    if (isContextExceededError(respErr)) {
      setContextExceededErr(respErr);
    } else {
      setErr(respErr);
    }
    updateLastEntry({ isLoading: false });
  };

  // ============================================================================
  // Business Logic - Query Execution
  // ============================================================================

  /**
   * Execute the actual chat query (first question in conversation).
   * Uses chat session facade for RAG search + context + session creation.
   */
  const executeChatQuery = async (queryParams) => {
    const { query, postType, categoryPrimary } = queryParams;

    // Reset for new conversation and add the first entry
    resetForNewConversation();
    setConversation([createLoadingEntry(query)]);
    setIsFetching(true);

    try {
      // Create chat session facade
      chatSessionRef.current = createChatSession({
        provider: modelObj.provider,
        model: modelObj.model,
        temperature,
      });

      let usage = null;
      let finishReason = null;
      let searchMetadata = null;

      // Start conversation (does RAG search + context + first message)
      for await (const event of chatSessionRef.current.start(query, {
        postType,
        minDate,
        categoryPrimary,
      })) {
        if (event.type === "search") {
          // Update UI with search results
          const {
            posts: fetchedPosts,
            chunks,
            metadata,
            displayPosts,
          } = event.message;
          searchMetadata = metadata;
          setSearchData({ posts: fetchedPosts, chunks, metadata });
          setPosts(displayPosts);
          setAnalyticsDates(metadata?.analytics?.dates);
        } else if (event.type === "data") {
          // Stream answer into the last conversation entry
          appendToLastAnswer(event.message);
        } else if (event.type === "finishReason") {
          finishReason = event.message;
        } else if (event.type === "usage") {
          usage = event.message;
        }
      }

      // Finalize the conversation entry with queryInfo
      const chunks = chatSessionRef.current.getSearchData()?.chunks ?? [];
      const queryInfo = buildQueryInfo({
        usage,
        finishReason,
        modelObj,
        searchMetadata,
        chunks,
      });
      updateLastEntry({ queryInfo, isLoading: false });
    } catch (respErr) {
      handleChatError(respErr);
      return;
    } finally {
      setIsFetching(false);
    }
  };

  /**
   * Execute a follow-up query using existing chat session.
   */
  const executeAskMore = async (query) => {
    setQueryValue("");
    setIsFetching(true);
    setErr(null);

    // Add new entry (loading state)
    setConversation((prev) => [...prev, createLoadingEntry(query)]);

    try {
      if (!chatSessionRef.current) {
        throw new Error(
          "No conversation session available. Please start a new conversation.",
        );
      }

      let usage = null;
      let finishReason = null;

      // Continue conversation using existing session
      for await (const event of chatSessionRef.current.continue(query)) {
        if (event.type === "data") {
          // Stream answer into the last conversation entry
          appendToLastAnswer(event.message);
        } else if (event.type === "finishReason") {
          finishReason = event.message;
        } else if (event.type === "usage") {
          usage = event.message;
        }
      }

      // Finalize entry with queryInfo
      const queryInfo = buildQueryInfo({ usage, finishReason, modelObj });
      updateLastEntry({ queryInfo, isLoading: false });
    } catch (respErr) {
      handleChatError(respErr);
    } finally {
      setIsFetching(false);
    }
  };

  // ============================================================================
  // Effect - Model Loading
  // ============================================================================

  /**
   * Execute pending query once model is loaded, or handle load error.
   */
  useEffect(() => {
    if (!isLoadingModelForChat) return;

    if (isModelLoaded && pendingQueryRef.current) {
      setIsLoadingModelForChat(false);
      const { queryParams, shouldContinue } = pendingQueryRef.current;
      pendingQueryRef.current = null;
      if (shouldContinue) {
        executeAskMore(queryParams.query);
      } else {
        executeChatQuery(queryParams);
      }
    } else if (modelStatus === "error") {
      // Keep isLoadingModelForChat true so LoadingButton stays visible
      pendingQueryRef.current = null;
      setErr(getError(modelResourceId));
    }
  }, [isModelLoaded, isLoadingModelForChat, modelStatus, modelResourceId]);

  // ============================================================================
  // Public API - Event Handlers
  // ============================================================================

  /**
   * Handle form submission.
   * Behavior depends on conversation state and whether conversations are enabled.
   */
  const handleSubmit = (event) => {
    event.preventDefault();
    const { query } = getElements(event);
    if (!query) {
      return;
    }

    // Infer other input parameters
    const postType = selectedPostTypes.map(({ value }) => value);
    const categoryPrimary = selectedCategoryPrimary.map(({ value }) => value);
    const queryParams = { query, postType, categoryPrimary };

    // Should we continue the existing conversation or start fresh?
    const shouldContinue = conversationsEnabled && isConversationActive;

    // If model not loaded, trigger loading and wait
    if (!isModelLoaded) {
      pendingQueryRef.current = { queryParams, shouldContinue };
      setIsLoadingModelForChat(true);
      startLoading(modelResourceId);
      return;
    }

    // Model is loaded, proceed
    if (shouldContinue) {
      executeAskMore(query);
    } else {
      executeChatQuery(queryParams);
    }
  };

  /**
   * Handle reset button - clears conversation and unlocks form inputs.
   */
  const handleReset = () => {
    resetForNewConversation();
  };

  // ============================================================================
  // Return Public API
  // ============================================================================

  return {
    // State
    conversation,
    isFetching,
    posts,
    searchData,
    analyticsDates,
    err,
    contextExceededErr,
    isLoadingModelForChat,

    // Derived state
    isConversationActive,
    hasCompletions,
    conversationsEnabled,
    formInputsLocked,
    placeholder,

    // Handlers
    handleSubmit,
    handleReset,
  };
};
