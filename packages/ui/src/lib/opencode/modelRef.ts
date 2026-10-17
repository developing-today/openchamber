/**
 * The real `provider/model#variant` a turn ran on, as opposed to a pool name
 * like `opencode-route/fast-strong`. Shared by the message footer, the
 * persistent current-model indicator, and the model-changed transcript
 * divider so all three agree on one compact form.
 */

export interface ModelRefLike {
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
}

/** `provider/model`, or `provider/model#variant` when the variant is not the model's default. */
export const formatModelRef = (ref: ModelRefLike): string => {
    const variant = ref.variant && ref.variant !== 'default' ? `#${ref.variant}` : '';
    return `${ref.providerID}/${ref.modelID}${variant}`;
};

/** Same provider, model and variant; `undefined` only equals `undefined`. */
export const isSameModelRef = (a: ModelRefLike | undefined, b: ModelRefLike | undefined): boolean => {
    if (!a || !b) return a === b;
    return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? undefined) === (b.variant ?? undefined);
};
