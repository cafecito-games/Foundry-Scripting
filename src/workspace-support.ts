export type NativeWorkspaceEligibility =
  | { readonly kind: "eligible" }
  | { readonly kind: "restricted" }
  | { readonly kind: "unsupported_scheme"; readonly scheme: string };

export function classifyNativeWorkspaceEligibility(
  isTrusted: boolean,
  workspaceFolderSchemes: readonly string[] | undefined,
): NativeWorkspaceEligibility {
  if (!isTrusted) {
    return { kind: "restricted" };
  }

  const firstScheme = workspaceFolderSchemes?.[0];
  if (firstScheme === undefined || firstScheme === "file") {
    return { kind: "eligible" };
  }

  return { kind: "unsupported_scheme", scheme: firstScheme };
}
