import React from 'react';
import type { MessageModelAttributionMap } from '../hooks/useMessageModelAttribution';

export const ModelAttributionContext = React.createContext<MessageModelAttributionMap>({});
