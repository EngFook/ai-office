import React, { createContext, useContext } from 'react';
import { officeIdentity, officeDate } from './office-identity.js';
import { useLang } from './i18n';

export const OfficeIdentityContext = createContext(officeIdentity());
export const useOfficeIdentity = () => useContext(OfficeIdentityContext);
export function useOfficeDate(options = {}) {
  const { timeZone } = useOfficeIdentity();
  const lang = useLang();
  return value => officeDate(value, { ...options, lang, timeZone });
}
