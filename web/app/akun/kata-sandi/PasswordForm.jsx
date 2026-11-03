"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

export default function PasswordForm({ className, errorClassName, submitClassName }) {
  const t = useTranslations("auth");
  const tAccount = useTranslations("errors.account");
  const refusals = {
    password_wrong: tAccount("password_wrong"),
    password_too_short: tAccount("password_too_short"),
    password_too_long: tAccount("password_too_long"),
    password_common: tAccount("password_common"),
    password_same_as_username: tAccount("password_same_as_username"),
  };
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("next") !== form.get("repeat")) {
      setError(tAccount("password_mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: form.get("current"), next: form.get("next") }),
      });
      if (response.ok) {
        window.location.assign("/dashboard");
        return;
      }
      const body = await response.json().catch(() => ({}));
      setError(Object.hasOwn(refusals, body.code) ? refusals[body.code] : t("password.failed"));
    } catch {
      setError(t("password.failed"));
    }
    setBusy(false);
  };

  return (
    <form className={className} onSubmit={submit}>
      <TextField name="current" type="password" isRequired autoFocus>
        <Label>{t("password.current")}</Label>
        <Input autoComplete="current-password" />
        <FieldError />
      </TextField>
      <TextField name="next" type="password" isRequired>
        <Label>{t("password.next")}</Label>
        <Input autoComplete="new-password" />
        <FieldError />
      </TextField>
      <TextField name="repeat" type="password" isRequired>
        <Label>{t("password.repeat")}</Label>
        <Input autoComplete="new-password" />
        <FieldError />
      </TextField>
      {error && <p className={errorClassName} role="alert">{error}</p>}
      <Button type="submit" variant="primary" className={submitClassName} isDisabled={busy}>{t("password.save")}</Button>
    </form>
  );
}
