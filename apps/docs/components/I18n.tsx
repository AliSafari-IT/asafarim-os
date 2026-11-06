"use client";
/** The page's words for client components: the layout provides them once, `useMessages()` reads them. */
import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@asafarim/locale";
import { messagesFor, type Messages } from "@/lib/i18n";

const Ctx = createContext<{ locale: Locale; messages: Messages }>({ locale: "en", messages: messagesFor("en") });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <Ctx.Provider value={{ locale, messages: messagesFor(locale) }}>{children}</Ctx.Provider>;
}

export const useMessages = () => useContext(Ctx).messages;
export const useLocale = () => useContext(Ctx).locale;
