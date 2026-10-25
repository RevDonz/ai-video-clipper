"use client";

// A card's loading and load-error states (05-ui-dashboard.md §6.10: Skeleton while it loads, a
// load error inside the card with Coba lagi; the other cards and tabs keep working).
import { Alert, Button, Skeleton } from "@heroui/react";
import { useTranslations } from "use-intl";

export function CardLoading({ label, lines = 2 }) {
  return (
    <div className="settingsLoading" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => <Skeleton key={index} className="settingsSkeleton" />)}
    </div>
  );
}

export function CardLoadError({ message, onRetry }) {
  const tCommon = useTranslations("common");
  return (
    <Alert status="danger" className="settingsLoadError" role="alert">
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
      <Button variant="secondary" onPress={onRetry}>{tCommon("retry")}</Button>
    </Alert>
  );
}

/** A problem worth stopping for (Alert, P-masalah saja): `tone` error or warning. */
export function CardNotice({ tone = "warning", title, children }) {
  return (
    <Alert status={tone === "error" ? "danger" : tone === "info" ? "default" : "warning"} className="settingsNotice" role={tone === "error" ? "alert" : undefined}>
      <Alert.Indicator />
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        {children ? <Alert.Description>{children}</Alert.Description> : null}
      </Alert.Content>
    </Alert>
  );
}
