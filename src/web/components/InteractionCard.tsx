import { type FormEvent, useState } from "react";
import type {
  InteractionRequest,
  InteractionResponse,
} from "../../shared/protocol";

type InteractionCardProps = {
  interaction: InteractionRequest;
  onResolve: (id: string, response: InteractionResponse) => void;
};

export function InteractionCard({
  interaction,
  onResolve,
}: InteractionCardProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  function setSingle(id: string, value: string) {
    setSelections((current) => ({ ...current, [id]: [value] }));
    setOtherText((current) => ({ ...current, [id]: "" }));
  }

  function toggleMultiple(id: string, value: string, checked: boolean) {
    setSelections((current) => {
      const selected = new Set(current[id] ?? []);
      if (checked) selected.add(value);
      else selected.delete(value);
      return { ...current, [id]: [...selected] };
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const answers = Object.fromEntries(
      interaction.questions.flatMap(({ id }) => {
        if (selections[id] === undefined && otherText[id] === undefined)
          return [];
        const text = otherText[id] ?? "";
        return [
          [id, [...(selections[id] ?? []), ...(text === "" ? [] : [text])]],
        ];
      }),
    );
    onResolve(interaction.id, { decision: "answer", answers });
  }

  return (
    <form className="interaction-card question-card" onSubmit={submit}>
      <strong>{interaction.title}</strong>
      {interaction.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.text}</legend>
          {question.options?.map((option) => (
            <label className="question-option" key={option.label}>
              <input
                checked={(selections[question.id] ?? []).includes(option.label)}
                name={question.id}
                onChange={(event) =>
                  question.multiple
                    ? toggleMultiple(
                        question.id,
                        option.label,
                        event.target.checked,
                      )
                    : setSingle(question.id, option.label)
                }
                type={question.multiple ? "checkbox" : "radio"}
                value={option.label}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {(question.options === undefined || question.allowOther) && (
            <input
              aria-label={`${question.text} 的文本回答`}
              value={otherText[question.id] ?? ""}
              onChange={(event) => {
                setOtherText((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }));
                if (!question.multiple)
                  setSelections((current) => ({
                    ...current,
                    [question.id]: [],
                  }));
              }}
              placeholder={
                question.options === undefined ? "输入回答" : "其他回答（可选）"
              }
              type={question.secret ? "password" : "text"}
            />
          )}
        </fieldset>
      ))}
      <button className="answer-button" type="submit">
        提交回答
      </button>
    </form>
  );
}
