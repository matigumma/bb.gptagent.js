import zod from "zod";
import { ActionRegistry } from "../action/ActionRegistry";
import { ResultFormatter } from "../action/result-formatter/ResultFormatter";
import { ResultFormatterRegistry } from "../action/result-formatter/ResultFormatterRegistry";
import { AgentRun } from "../agent/AgentRun";
import { OpenAIChatMessage } from "../ai/openai/createChatCompletion";
import { ChatTextGenerator } from "../component/text-generator/ChatTextGenerator";
import { ErrorStep } from "./ErrorStep";
import { NextStepGenerator } from "./NextStepGenerator";
import { NoopStep } from "./NoopStep";
import { Step } from "./Step";

export class BasicNextStepGenerator implements NextStepGenerator {
  readonly role: string;
  readonly constraints: string;
  readonly actionRegistry: ActionRegistry;
  readonly textGenerator: ChatTextGenerator;
  readonly resultFormatterRegistry: ResultFormatterRegistry;

  constructor({
    role,
    constraints,
    actionRegistry,
    textGenerator,
    resultFormatterRegistry = new ResultFormatterRegistry(),
  }: {
    role: string;
    constraints: string;
    actionRegistry: ActionRegistry;
    textGenerator: ChatTextGenerator;
    resultFormatterRegistry?: ResultFormatterRegistry;
  }) {
    if (role == null) {
      throw new Error("role is required");
    }
    if (constraints == null) {
      throw new Error("constraints is required");
    }
    if (actionRegistry == null) {
      throw new Error("actionRegistry is required");
    }
    if (textGenerator == null) {
      throw new Error("textGenerator is required");
    }

    this.role = role;
    this.constraints = constraints;
    this.actionRegistry = actionRegistry;
    this.textGenerator = textGenerator;
    this.resultFormatterRegistry = resultFormatterRegistry;
  }

  generateMessages({
    completedSteps,
    run,
  }: {
    completedSteps: Array<Step>;
    run: AgentRun;
  }): Array<OpenAIChatMessage> {
    const messages: Array<OpenAIChatMessage> = [
      {
        role: "system",
        content: `## ROLE
${this.role}

## CONSTRAINTS
${this.constraints};

## AVAILABLE ACTIONS
${this.actionRegistry.getAvailableActionInstructions()}`,
      },
      { role: "user", content: `## TASK\n${run.instructions}` },
    ];

    for (const step of completedSteps) {
      // repeat the original agent response to reinforce the action format and keep the conversation going:
      if (step.generatedText != null) {
        messages.push({
          role: "assistant",
          content: step.generatedText,
        });
      }

      let content: string | undefined = undefined;

      const stepState = step.state;
      switch (stepState.type) {
        case "failed": {
          content = `ERROR:\n${stepState.summary}`;
          break;
        }
        case "succeeded": {
          if (stepState.output == null) {
            break;
          }

          const resultFormatter =
            this.resultFormatterRegistry.getResultFormatter(step.type);

          if (resultFormatter == null) {
            content = JSON.stringify(stepState.output);
            break;
          }

          content = this.formatOutput({
            resultFormatter,
            result: stepState,
          });
        }
      }

      if (content != null) {
        messages.push({
          role: "system",
          content,
        });
      }
    }

    return messages;
  }

  private formatOutput<OUTPUT>({
    resultFormatter,
    result,
  }: {
    result: unknown;
    resultFormatter: ResultFormatter<OUTPUT>;
  }) {
    const schema = zod.object({
      output: resultFormatter.outputSchema,
      summary: zod.string(),
    });

    const parsedResult = schema.parse(result);

    return resultFormatter.formatResult({
      result: {
        summary: parsedResult.summary,
        output: parsedResult.output as any, // TODO fix type issue
      },
    });
  }

  async generateNextStep({
    completedSteps,
    run,
  }: {
    completedSteps: Array<Step>;
    run: AgentRun;
  }): Promise<Step> {
    const messages = this.generateMessages({ completedSteps, run });

    run.observer?.onStepGenerationStarted({ run, messages });

    const generatedText = await this.textGenerator.generateText(
      { messages },
      run
    );

    const actionParameters = this.actionRegistry.format.parse(generatedText);

    let step: Step;
    if (actionParameters.action == null) {
      step = new NoopStep({
        type: "thought",
        generatedText,
        summary: actionParameters._freeText,
      });
    } else {
      try {
        const action = this.actionRegistry.getAction(actionParameters.action);

        step = await action.createStep({
          generatedText,
          input: actionParameters,
        });
      } catch (error: any) {
        step = new ErrorStep({
          generatedText,
          error,
        });
      }
    }

    run.observer?.onStepGenerationFinished({ run, generatedText, step });

    return step;
  }
}