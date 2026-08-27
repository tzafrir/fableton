// SS5 control inventory: Enum select — "segmented control <=4 labels,
// dropdown above that" — and Toggle LED. Both commit exactly one undo entry
// per interaction (the click IS the gesture), through the same handle
// contract every other control uses.

import type { ParamHandle } from "../../types";
import { useParamValue } from "./ParamControl";

export interface EnumSelectProps {
  handle: ParamHandle;
  testId?: string | undefined;
}

export function EnumSelect({ handle, testId }: EnumSelectProps) {
  const value = useParamValue(handle);
  const labels = handle.desc.labels ?? [];
  const index = Math.round(value);

  const pick = (i: number): void => {
    handle.setLive(i, "user");
    handle.commit();
  };

  if (labels.length <= 4) {
    return (
      <div
        className="fbl-enum"
        data-testid={testId}
        role="radiogroup"
        aria-label={handle.desc.label}
        style={{ display: "inline-flex", gap: 2 }}
      >
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={i === index}
            onClick={() => pick(i)}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              background: i === index ? "#5aa9e6" : "#222",
              color: i === index ? "#000" : "#bbb",
              border: "1px solid #444",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      className="fbl-enum"
      data-testid={testId}
      aria-label={handle.desc.label}
      value={index}
      onChange={(e) => pick(Number(e.target.value))}
      style={{ fontSize: 11 }}
    >
      {labels.map((label, i) => (
        <option key={label} value={i}>
          {label}
        </option>
      ))}
    </select>
  );
}

export interface ToggleLEDProps {
  handle: ParamHandle;
  testId?: string | undefined;
  label?: string | undefined;
}

export function ToggleLED({ handle, testId, label }: ToggleLEDProps) {
  const value = useParamValue(handle);
  const on = value >= 0.5;
  return (
    <button
      type="button"
      className="fbl-toggle-led"
      data-testid={testId}
      role="switch"
      aria-checked={on}
      aria-label={label ?? handle.desc.label}
      title={label ?? handle.desc.label}
      onClick={() => {
        handle.setLive(on ? 0 : 1, "user");
        handle.commit();
      }}
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        border: "1px solid #555",
        background: on ? "#7ad67a" : "#222",
        cursor: "pointer",
        padding: 0,
      }}
    />
  );
}
