import { useState, useEffect } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { PostsTable } from "../components/posts-table.js";
import {
  Form,
  PostMinDate,
  PostTypeSelect,
  PostCategoryPrimarySelect,
} from "../components/forms.js";
import {
  DownloadPostsCsv,
  JsonDataLink,
} from "../components/posts-download.js";
import { useSettings } from "../hooks/use-settings.js";
import { posts as getPosts } from "../data/index.js";
import { useLoading } from "../../local/app/context/loading.js";
import {
  LoadingMessage,
  LOADING,
} from "../../local/app/components/loading/index.js";

export const Posts = () => {
  const [posts, setPosts] = useState(null);
  const [postsData, setPostsData] = useState(null);
  const [analyticsDates, setAnalyticsDates] = useState({
    start: null,
    end: null,
  });
  const [selectedPostTypes, setSelectedPostTypes] = useState([]);
  const [selectedCategoryPrimary, setSelectedCategoryPrimary] = useState([]);
  const [minDate, setMinDate] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;
  const { getStatus } = useLoading();
  const postsDataStatus = getStatus(LOADING.POSTS_DATA);

  // Helper function to fetch posts
  const fetchPosts = async () => {
    const data = await getPosts({
      minDate,
      postType: selectedPostTypes.map(({ value }) => value),
      categoryPrimary: selectedCategoryPrimary.map(({ value }) => value),
      withContent: false,
    });
    setPostsData(data);
    setPosts(data.posts);
    setAnalyticsDates(data.metadata?.analytics?.dates);
  };

  // TODO(LOADING): Can we skip this if postsDataStatus is loaded and directly set posts?
  useEffect(() => {
    fetchPosts();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsFetching(true);
    setPosts(null);
    setPostsData(null);
    await fetchPosts();
    setIsFetching(false);
  };

  return html`
    <${Page} name="Posts">
      <p>
        List (and filter) blog / case study / services
        pages${isDeveloperMode && ", without querying a database or service"}.
        ${" "}
        ${isDeveloperMode && postsData && html`<${JsonDataLink} data=${postsData} />`}
        <${DownloadPostsCsv} posts=${posts} />
      </p>
      <${LoadingMessage} resourceId=${LOADING.POSTS_DATA} type="error" />
      <${Form} ...${{ isFetching, handleSubmit, submitName: "Filter" }}>
        <${PostTypeSelect}
          selected=${selectedPostTypes}
          setSelected=${setSelectedPostTypes}
        />
        <${PostCategoryPrimarySelect}
          selected=${selectedCategoryPrimary}
          setSelected=${setSelectedCategoryPrimary}
        />
        <${PostMinDate} value=${minDate} setValue=${setMinDate} />
      </${Form}>
      ${
        (posts &&
          html`<${PostsTable}
            posts=${posts}
            analyticsDates=${analyticsDates}
          />`) ||
        html`<${LoadingMessage}
          resourceId=${LOADING.POSTS_DATA}
          type="info"
          message=${postsDataStatus === "loading"
            ? "Loading posts data..."
            : null}
        />`
      }
    </${Page}>
  `;
};
