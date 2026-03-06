import { useState } from "react";

import { Link } from "react-router";
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
} from "../components/forms.js";
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
import { QueryDisplay } from "../components/query-display.js";
import { Description } from "../components/description.js";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_TEMPERATURE,
  getModelCfg,
} from "../../config.js";

const SUGGESTIONS = [
  "Tell me 2 sentences about Nearform's expertise in using AI for software development.",
  "Give me a single paragraph about Nearform's React and React Native expertise.",
  "What case studies show Nearform building design systems for global brands?",
  "How does Nearform approach accessibility in mobile applications?",
  "Summarize Nearform's work with Node.js in enterprise companies.",
  "What open source tools has Nearform contributed to the React ecosystem?",
  "Explain in 2 sentences how Nearform uses GraphQL in their projects.",
  "What are Nearform's recommendations for choosing between open and closed AI models?",
  "Give me a brief overview of Nearform's serverless and cloud expertise.",
  "How has Nearform helped companies modernize their frontend architectures?",
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
              <strong>Temperature</strong>: Control the creativity and
              randomness of AI responses, from 0 (more focused and
              deterministic) to 1 (more creative and varied).
            </li>
          `
        }
      </ul>
    </${Description}>
  `;
};

export const Chat = () => {
  // Randomly select 3 suggestions on mount (persists during session)
  const [displayedSuggestions] = useState(() => getRandomItems(SUGGESTIONS, 3));

  // Form state
  const [selectedPostTypes, setSelectedPostTypes] = useState([]);
  const [selectedCategoryPrimary, setSelectedCategoryPrimary] = useState([]);
  const [selectedVerticalPrimary, setSelectedVerticalPrimary] = useState([]);
  const [modelObj, setModelObj] = useState(DEFAULT_CHAT_MODEL);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [minDate, setMinDate] = useState("");

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
    err,
    contextExceededErr,
    isLoadingModelForChat,
    hasCompletions,
    conversationsEnabled,
    formInputsLocked,
    placeholder,
    handleSubmit,
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
  });

  return html`
    <${Page} name="Chat">
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
      ${posts && html`<${PostsFound} ...${{ posts, analyticsDates }} />`}

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
        (entry, idx) => html`
          <div
            key=${`conversation-entry-${idx}`}
            className="conversation-entry"
          >
            <${QueryDisplay} query=${entry.query} />
            ${entry.isLoading && !entry.answer && html`<${LoadingBubble} />`}
            ${entry.answer &&
            html`<${Answer}
              answer=${entry.answer}
              queryInfo=${entry.queryInfo}
              onNewConversation=${handleReset}
            />`}
          </div>
        `,
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
