import * as $ from "@gptagent/agent";
import { runCLIAgent } from "@gptagent/agent";
import dotenv from "dotenv";

dotenv.config();

const textGenerator = new $.ai.openai.OpenAiChatTextGenerator({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model: "gpt-3.5-turbo",
});

const searchWikipediaAction = $.tool.programmableGoogleSearchEngineAction({
  id: "search-wikipedia",
  description: "Search wikipedia using a search term. Returns a list of pages.",
  execute: $.tool.executeProgrammableGoogleSearchEngineAction({
    key: process.env.WIKIPEDIA_SEARCH_KEY ?? "",
    cx: process.env.WIKIPEDIA_SEARCH_CX ?? "",
  }),
});

const readWikipediaArticleAction = $.tool.summarizeWebpage({
  id: "read-wikipedia-article",
  description:
    "Read a wikipedia article and summarize it considering the query.",
  inputExample: {
    url: "https://en.wikipedia.org/wiki/Artificial_intelligence",
    topic: "{query that you are answering}",
  },
  execute: $.tool.executeSummarizeWebpage({
    webpageTextExtractor:
      new $.component.webpageTextExtractor.BasicWebpageTextExtractor(),
    summarizer: new $.component.textSummarizer.RecursiveSplitSummarizer({
      splitter: new $.component.splitter.RecursiveCharacterSplitter({
        // note: maxCharactersPerChunk can be increased to 4096 * 4 when you use gpt-4
        maxCharactersPerChunk: 2048 * 4,
      }),
      summarizer: new $.component.textSummarizer.ChatTextSummarizer({
        chatTextGenerator: textGenerator,
      }),
    }),
  }),
});

runCLIAgent({
  agent: new $.agent.Agent({
    name: "Wikipedia QA",
    execute: $.step.createGenerateNextStepLoop({
      prompt: new $.prompt.CompositePrompt(
        new $.prompt.FixedSectionsPrompt({
          sections: [
            {
              title: "Role",
              // Note: "You speak perfect JSON" helps getting gpt-3.5-turbo to provide structured json at the end
              content: `You are an knowledge worker that answers questions using Wikipedia content.
You speak perfect JSON.`,
            },
            {
              title: "Constraints",
              content: `Make sure all facts for your answer are from Wikipedia articles that you have read.`,
            },
          ],
        }),
        new $.prompt.TaskSectionPrompt(),
        new $.prompt.AvailableActionsSectionPrompt(),
        new $.prompt.RecentStepsPrompt({ maxSteps: 6 })
      ),
      actionRegistry: new $.action.ActionRegistry({
        actions: [searchWikipediaAction, readWikipediaArticleAction],
        format: new $.action.format.JsonActionFormat(),
      }),
      textGenerator,
    }),
  }),
  observer: new $.agent.ConsoleAgentRunObserver(),
});
