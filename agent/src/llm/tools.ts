import { ChatCompletionTool } from "openai/resources/chat/completions";

export const guardianTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "execute_action",
    description: "Perform an action via Agent Guardian on connected services. Use this to take actions on behalf of the user, such as managing GitHub repositories, branches, or other connections.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "The targeted service provider (e.g., 'github', 'slack').",
        },
        actionType: {
          type: "string",
          description: "The specific action identifier (e.g., 'github.delete_branch', 'github.create_issue').",
        },
        payload: {
          type: "object",
          description: "The parameters required for this action. For example: { repo: 'Test' }.",
          properties: {
            repo: { type: "string", description: "The targeted GitHub repository name." },
            owner: { type: "string", description: "The GitHub owner/username. Optional." },
            branch: { type: "string", description: "The target branch name." },
            title: { type: "string" },
            body: { type: "string" },
            issueNumber: { type: "number" },
            prNumber: { type: "number" }
          },
          additionalProperties: true,
        },
        displaySummary: {
          type: "string",
          description: "A very brief, human-readable summary of what you are doing to be shown in the UI."
        }
      },
      required: ["service", "actionType", "payload", "displaySummary"],
    },
  },
};
  