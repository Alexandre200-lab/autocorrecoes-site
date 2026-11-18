import { complete, type CompletionArgs } from "./client.js";

/** Porta de IA: permite trocar DeepSeek por stub em testes sem tocar no pipeline. */
export interface AiProvider {
  complete(args: CompletionArgs): Promise<string>;
  readonly name: string;
}

export const deepSeekProvider: AiProvider = {
  name: "deepseek",
  complete,
};
