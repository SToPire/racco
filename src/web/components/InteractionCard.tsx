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
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  function setSingle(id: string, value: string) {
    setAnswers((current) => ({ ...current, [id]: [value] }));
  }

  function toggleMultiple(id: string, value: string, checked: boolean) {
    setAnswers((current) => {
      const selected = new Set(current[id] ?? []);
      if (checked) selected.add(value);
      else selected.delete(value);
      return { ...current, [id]: [...selected] };
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
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
                checked={(answers[question.id] ?? []).includes(option.label)}
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
              onChange={(event) => setSingle(question.id, event.target.value)}
              placeholder="输入回答"
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
