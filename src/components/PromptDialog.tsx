import { finishPrompt, prompt, promptRefs } from "../lib/state/ui";
import { Ico } from "../lib/icons";
import { X } from "lucide";

export default function PromptDialog() {
  let overlay!: HTMLDivElement;
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === overlay) finishPrompt(null);
  };
  return (
    <div
      ref={overlay}
      id="prompt-overlay"
      classList={{ open: prompt().open, confirm: prompt().confirm }}
      onClick={onOverlayClick}
    >
      <div class="settings-card prompt-card">
        <div class="settings-head">
          <span class="section-label">{prompt().title}</span>
          <button id="prompt-close" class="tbtn" title="Cancel" onClick={() => finishPrompt(null)}>
            <Ico node={X} size={15} />
          </button>
        </div>
        <div class="prompt-body">
          <p id="prompt-msg" class="hint" classList={{ hidden: !prompt().showMsg }}>
            {prompt().msg}
          </p>
          <input
            ref={(e) => (promptRefs.input = e)}
            id="prompt-input"
            type="text"
            spellcheck={false}
            classList={{ hidden: !prompt().showInput }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                promptRefs.ok?.click();
              } else if (e.key === "Escape") {
                finishPrompt(null);
              }
            }}
          />
          <div class="prompt-actions">
            <button id="prompt-cancel" class="btn" onClick={() => finishPrompt(null)}>
              Cancel
            </button>
            <button
              ref={(e) => (promptRefs.ok = e)}
              id="prompt-ok"
              class="btn primary"
              onClick={() => {
                // confirm mode (input hidden): always non-null → resolve(true).
                // prompt mode: empty input resolves null, like the original.
                if (!prompt().showInput) {
                  finishPrompt("ok");
                  return;
                }
                const input = promptRefs.input;
                const v = input ? input.value.trim() : "";
                finishPrompt(v.length ? v : null);
              }}
            >
              {prompt().okText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
