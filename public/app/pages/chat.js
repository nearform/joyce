import { useState, useMemo } from "react";

import { Link, useSearchParams } from "react-router";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import {
  ModelChatSelectDropdown,
  TemperatureDropdown,
  PostMinDateDropdown,
  PostTypeSelectDropdown,
  PostCategoryPrimarySelectDropdown,
  PostVerticalPrimarySelectDropdown,
  QueryField,
  ChatInputForm,
  POST_TYPE_OPTIONS,
  CATEGORY_OPTIONS,
  VERTICAL_OPTIONS,
} from "../components/forms.js";
import {
  parseMulti,
  parseStringParam,
  parseFloatParam,
  parseModel,
  buildParams,
  multiToValues,
} from "../util/url-params.js";
import { Answer } from "../components/answer.js";
import { PostsFound } from "../components/posts-found.js";
import {
  DownloadPostsCsv,
  JsonDataLink,
} from "../components/posts-download.js";
import { useSettings } from "../hooks/use-settings.js";
import { useChatSession } from "../hooks/use-chat-session.js";
import { useConfig } from "../contexts/config.js";
import { useLoading } from "../../local/app/context/loading.js";
import { LoadingButton } from "../../local/app/components/loading/button.js";
import { Alert } from "../components/alert.js";
import { ContextExceededError } from "../components/context-messages.js";
import { SuggestedQueries } from "../components/suggested-queries.js";
import { LoadingBubble } from "../components/loading-bubble.js";
import { parseThinking } from "../util/think.js";
import { QueryDisplay } from "../components/query-display.js";
import { Description } from "../components/description.js";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_TEMPERATURE,
  getModelCfg,
} from "../../config.js";

const SUGGESTIONS = [
  "How did Nearform help Walmart transform their checkout experience?",
  "What AI-powered transformation did Nearform deliver for the executive search consultancy?",
  "How was Nomo, the digital-only bank, launched in under 9 months?",
  "What is AI-native engineering and how does it change product development?",
  "How did Nearform scale Puma's e-commerce platform globally?",
  "What are best practices for implementing MCP servers?",
  "How is Nearform using on-device AI and browser-based vector search?",
  "How did Nearform help PUMA unify their fragmented regional e-commerce platforms?",
  "What should enterprises consider when choosing open vs closed LLMs?",
  "How did Nearform help Starbucks build their progressive web app?",
];

// Randomly select N items from an array using Fisher-Yates shuffle
const getRandomItems = (array, count) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
};

export const ShortDescription = () => html`
  <p>
    Our <${Link} to="/chat">chat</${Link}> page uses Retrieval-Augmented Generation (RAG) to
    generate text responses based on a user query and context. The context is supplied by the
    application, which in our case is to create embeddings from the user query, match similar
    blog/work posts using the same approach as in the <${Link} to="/search">search</${Link}> page,
    and then taking as much content from those similar posts to add in to the overall prompt we send
    to an AI model to get an answer.
  </p>
`;

const DescriptionButton = () => {
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  return html`
    <${Description}>
      <${ShortDescription} />
      <p>Notable options:</p>
      <ul>
        <li>
          <i className="iconoir-edit"></i> <strong>Query</strong>: Enter your question or request in the text area to generate AI responses based on our content.
        </li>
        <li>
          <i className="iconoir-multiple-pages"></i> <strong>Post Types</strong>: Filter content by selecting specific types of posts (Services, Work, Blogs) to include in the AI's context.
        </li>
        <li>
          <i className="iconoir-list-select"></i> <strong>Categories</strong>: Filter content by selecting specific categories to narrow down the posts used for generating responses.
        </li>
        <li>
          <i className="iconoir-building"></i> <strong>Verticals</strong>: Filter content by selecting specific industry verticals (health, finance, retail, etc.) to narrow down the posts used for generating responses.
        </li>
        <li>
          <i className="iconoir-calendar"></i> <strong>Date</strong>: Filter content to only include posts published on or after the selected date.
        </li>
        <li>
          <i className="iconoir-sparks"></i> <strong>Model</strong>: Choose the AI language model. Local models must be loaded before use, which may take a moment on first request. Different models offer varying speed, quality, and memory trade-offs.
        </li>
        ${
          isDeveloperMode &&
          html`
            <li>
              <i className="iconoir-temperature-high"></i>
              ${" "}<strong>Temperature</strong>: Control the creativity and
              randomness of AI responses, from 0 (more focused and
              deterministic) to 1 (more creative and varied).
            </li>
          `
        }
      </ul>
    </${Description}>
  `;
};

// One conversation turn. Parses the answer's reasoning once, memoized on the answer text, so a
// streaming render only re-parses the entry that's actively growing — prior entries' answers are
// stable, so their memo short-circuits (vs. re-scanning every entry on every token). Gate the answer
// box on the VISIBLE answer (reasoning stripped): reasoning models stream `<think>…</think>` before
// any real answer text, so this keeps the loading dots up while the model is only reasoning instead
// of flashing an empty answer box with action icons.
const ConversationEntry = ({ entry, onNewConversation }) => {
  const think = useMemo(() => parseThinking(entry.answer), [entry.answer]);
  return html`
    <div className="conversation-entry">
      <${QueryDisplay} query=${entry.query} />
      ${entry.isLoading && !think.visible && html`<${LoadingBubble} />`}
      ${think.visible &&
      html`<${Answer}
        answer=${entry.answer}
        think=${think}
        queryInfo=${entry.queryInfo}
        onNewConversation=${onNewConversation}
      />`}
    </div>
  `;
};

export const Chat = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Randomly select 3 suggestions on mount (persists during session)
  const [displayedSuggestions] = useState(() => getRandomItems(SUGGESTIONS, 3));

  // Form state — seeded from URL search params on first render only.
  const [selectedPostTypes, setSelectedPostTypes] = useState(() =>
    parseMulti(searchParams, "postType", POST_TYPE_OPTIONS),
  );
  const [selectedCategoryPrimary, setSelectedCategoryPrimary] = useState(() =>
    parseMulti(searchParams, "categoryPrimary", CATEGORY_OPTIONS),
  );
  const [selectedVerticalPrimary, setSelectedVerticalPrimary] = useState(() =>
    parseMulti(searchParams, "verticalPrimary", VERTICAL_OPTIONS),
  );
  const [modelObj, setModelObj] = useState(() =>
    parseModel(searchParams, "model", DEFAULT_CHAT_MODEL),
  );
  const [temperature, setTemperature] = useState(() =>
    parseFloatParam(searchParams, "temperature", DEFAULT_TEMPERATURE),
  );
  const [minDate, setMinDate] = useState(() =>
    parseStringParam(searchParams, "minDate", ""),
  );

  // Settings and config
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;
  const config = useConfig();
  const providers = new Set(
    Object.entries(config.providers)
      .filter(([, { enabled }]) => enabled)
      .map(([provider]) => provider),
  );

  // Model loading status
  const { getStatus, getError, startLoading } = useLoading();
  const modelResourceId = `llm_${modelObj.model}`;
  const modelStatus = getStatus(modelResourceId);
  const isModelLoaded = modelStatus === "loaded";

  // Chat session hook - encapsulates all business logic
  const {
    conversation,
    isFetching,
    posts,
    searchData,
    analyticsDates,
    usedChunks,
    chunkTexts,
    err,
    contextExceededErr,
    isLoadingModelForChat,
    hasCompletions,
    conversationsEnabled,
    formInputsLocked,
    placeholder,
    handleSubmit: sessionHandleSubmit,
    handleReset,
  } = useChatSession({
    modelObj,
    temperature,
    minDate,
    selectedPostTypes,
    selectedCategoryPrimary,
    selectedVerticalPrimary,
    isModelLoaded,
    startLoading,
    getError,
    modelResourceId,
    modelStatus,
    conversationsEnabled: settings.experimentalChatConversations,
    enableThinking: settings.enableThinking,
  });

  const handleSubmit = (event) => {
    setSearchParams(
      buildParams({
        postType: multiToValues(selectedPostTypes),
        categoryPrimary: multiToValues(selectedCategoryPrimary),
        verticalPrimary: multiToValues(selectedVerticalPrimary),
        minDate,
        model: modelObj,
        temperature,
      }),
      { replace: true },
    );
    sessionHandleSubmit(event);
  };

  return html`
    <${Page} name="Chat" icon="iconoir-chat-bubble">
      <p>
        Use fancy AI to generate answers / text from our blogs / case
        studies / services. You can filter the content we use
        with the form inputs below (dates, categories, etc.).
        ${" "}
        ${isDeveloperMode && searchData && html`<${JsonDataLink} data=${searchData} />`}
        <${DownloadPostsCsv} posts=${posts} />
      </p>

      <${DescriptionButton} />
      <${SuggestedQueries} ...${{ suggestions: displayedSuggestions, isFetching }} />
      ${posts && html`<${PostsFound} ...${{ posts, analyticsDates, usedChunks, chunkTexts }} />`}

      ${err && html`<${Alert} type="error" err=${err}>${err.toString()}</${Alert}>`}

      ${
        isLoadingModelForChat &&
        html`
        <${LoadingButton} resourceId=${modelResourceId} label=${getModelCfg(modelObj).modelShortName}>
          Loading model <strong>${getModelCfg(modelObj).modelShortName}</strong>
        </${LoadingButton}>
      `
      }

      ${conversation.map(
        (entry, idx) =>
          html`<${ConversationEntry}
            key=${`conversation-entry-${idx}`}
            entry=${entry}
            onNewConversation=${handleReset}
          />`,
      )}

      <${ContextExceededError}
        error=${contextExceededErr}
        onNewConversation=${handleReset}
      />

      <${ChatInputForm}
        isFetching=${isFetching}
        onSubmit=${handleSubmit}
        onReset=${handleReset}
        hasCompletions=${hasCompletions}
        conversationsEnabled=${conversationsEnabled}
      >
        <${QueryField} placeholder=${placeholder} />
        <${PostTypeSelectDropdown}
          selected=${selectedPostTypes}
          setSelected=${setSelectedPostTypes}
          disabled=${formInputsLocked}
        />
        <${PostCategoryPrimarySelectDropdown}
          selected=${selectedCategoryPrimary}
          setSelected=${setSelectedCategoryPrimary}
          disabled=${formInputsLocked}
        />
        <${PostVerticalPrimarySelectDropdown}
          selected=${selectedVerticalPrimary}
          setSelected=${setSelectedVerticalPrimary}
          disabled=${formInputsLocked}
        />
        <${PostMinDateDropdown}
          value=${minDate}
          onChange=${setMinDate}
          disabled=${formInputsLocked}
        />
        <${ModelChatSelectDropdown}
          selected=${modelObj}
          setSelected=${setModelObj}
          providers=${providers}
          disabled=${formInputsLocked}
        />
        <${TemperatureDropdown}
          hidden=${!isDeveloperMode}
          value=${temperature}
          onChange=${setTemperature}
          disabled=${formInputsLocked}
        />
      </${ChatInputForm}>
    </${Page}>
  `;
};
