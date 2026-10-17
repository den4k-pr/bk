import { useCallback, useState } from "react";

// УВАГА: раніше тут лежав захардкоджений секретний ключ OpenAI (sk-proj-…).
// Його прибрано — секрети не мають жити в коді клієнта (витягуються з бінарника).
// Якщо цей ключ десь ще вживався, його обов'язково треба ВІДКЛИКАТИ в OpenAI.

export const useTranslateInput = () => {
  const [english, setEnglish] = useState<string>("");
  const [ukrainian, setUkrainian] = useState<string>("");

  const translateText = useCallback(
    async (text: string, from: string, to: string) => {
      if (!text.trim()) return "";

      try {
        const response = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, from, to }),
          });
          const data = await response.json();
          return data.translated;
      } catch (error) {
        console.error("Помилка при перекладі GPT:", error);
        return "";
      }
    },
    []
  );

  const handleEnglishChange = useCallback(
    async (text: string) => {
      setEnglish(text);
      if (text.trim()) {
        const translated = await translateText(text, "English", "Ukrainian");
        setUkrainian(translated);
      } else {
        setUkrainian("");
      }
    },
    [translateText]
  );

  const handleUkrainianChange = useCallback(
    async (text: string) => {
      setUkrainian(text);
      if (text.trim()) {
        const translated = await translateText(text, "Ukrainian", "English");
        setEnglish(translated);
      } else {
        setEnglish("");
      }
    },
    [translateText]
  );

  return {
    english,
    ukrainian,
    handleEnglishChange,
    handleUkrainianChange,
  };
};
