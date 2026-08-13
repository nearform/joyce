// Browser-side: drive a real chat session. See ./README.md for the rules — especially rule 4.

/**
 * Start a chat session and stream every turn back over the binding.
 *
 * Returns IMMEDIATELY (rule 4). Generation runs for minutes, so the terminal payload is sent as a
 * final `complete` binding event rather than being awaited as this function's return value. A
 * pending `awaitPromise` evaluate held open across a generation would die with "Promise was
 * collected" whenever the tab is disturbed.
 *
 * This calls the app's own `createChatSession` via a main-world dynamic import, so it shares the
 * running app's Orama databases, embedding extractor, and resident model. It is the real pipeline,
 * not a reimplementation.
 *
 * Events emitted:
 *   {type:"search"}       retrieval finished
 *   {type:"firstToken"}   first delta arrived
 *   {type:"delta"}        heartbeat every 25 deltas (never the text itself)
 *   {type:"turnDone"}     one turn finished
 *   {type:"complete"}     all turns done; carries the full payload (chunked by the sender)
 *   {type:"failed"}       generation threw
 *
 * @param {Object} arg
 * @returns {string} JSON string acknowledging the start
 */
export const runTurns = (arg) => {
  const MAX = 60000;
  let seq = 0;
  const send = (event) => {
    const body = JSON.stringify(event);
    if (body.length <= MAX) {
      window[arg.bindingName](body);
      return;
    }
    const id = `c${(seq += 1)}`;
    const total = Math.ceil(body.length / MAX);
    for (let i = 0; i < total; i += 1) {
      window[arg.bindingName](
        JSON.stringify({
          __chunk: { id, i, total, s: body.slice(i * MAX, (i + 1) * MAX) },
        }),
      );
    }
  };

  // Kick off asynchronously and return; Node resolves on the `complete` event.
  (async () => {
    let session = null;
    try {
      const api = await import(`${arg.base}local/data/api/index.js`);
      session = api.createChatSession({
        provider: arg.provider,
        model: arg.model,
        temperature: arg.temperature,
        enableThinking: arg.enableThinking,
      });

      const turns = [];

      const consume = async (iterator, turnIndex, userQuery) => {
        const startedAt = performance.now();
        const turn = {
          turn: turnIndex,
          query: userQuery,
          rawAnswer: "",
          usage: null,
          finishReason: null,
          searchData: null,
          timings: {
            searchMs: null,
            firstTokenMs: null,
            lastTokenMs: null,
            deltaCount: 0,
          },
        };

        for await (const event of iterator) {
          if (event.type === "search") {
            turn.timings.searchMs = Math.round(performance.now() - startedAt);
            turn.searchData = event.message;
            send({
              type: "search",
              turn: turnIndex,
              chunkCount: ((event.message && event.message.chunks) || [])
                .length,
              ms: turn.timings.searchMs,
            });
          } else if (event.type === "data") {
            if (turn.timings.firstTokenMs === null) {
              turn.timings.firstTokenMs = Math.round(
                performance.now() - startedAt,
              );
              send({
                type: "firstToken",
                turn: turnIndex,
                ms: turn.timings.firstTokenMs,
              });
            }
            turn.rawAnswer += event.message;
            turn.timings.deltaCount += 1;
            // Heartbeat only — never stream the answer text over the binding.
            if (turn.timings.deltaCount % 25 === 0) {
              send({
                type: "delta",
                turn: turnIndex,
                chars: turn.rawAnswer.length,
              });
            }
          } else if (event.type === "finishReason") {
            turn.finishReason = event.message;
          } else if (event.type === "usage") {
            // The richest signal available: carries the exact messages array the model saw
            // (`prompt`) and the raw XML context, plus tokens and timings.
            turn.usage = event.message;
          }
        }

        turn.timings.lastTokenMs = Math.round(performance.now() - startedAt);
        turn.usedChunks = session.getUsedChunks();
        turn.chunkTexts = session.getChunkTexts();
        turn.tokenUsage = session.getTokenUsage();
        turns.push(turn);
        send({
          type: "turnDone",
          turn: turnIndex,
          chars: turn.rawAnswer.length,
          ms: turn.timings.lastTokenMs,
        });
      };

      await consume(session.start(arg.query, arg.filters), 1, arg.query);

      for (let i = 0; i < (arg.followUps || []).length; i += 1) {
        if (!session.canContinue()) {
          send({ type: "cannotContinue", turn: i + 2 });
          break;
        }
        await consume(
          session.continue(arg.followUps[i]),
          i + 2,
          arg.followUps[i],
        );
      }

      send({
        type: "complete",
        payload: { turns, history: session.getHistory() },
      });
    } catch (err) {
      send({
        type: "failed",
        message: String(err && err.message ? err.message : err),
        stack: String((err && err.stack) || ""),
      });
    } finally {
      if (session) {
        try {
          session.destroy();
        } catch {
          // Teardown must never mask the real error.
        }
      }
    }
  })();

  return JSON.stringify({ started: true });
};
