/** Wrapper cross-platform para executar o eval com o provider determinístico. */
process.env.EVAL_MOCK = "1";

await import("./eval.js");
