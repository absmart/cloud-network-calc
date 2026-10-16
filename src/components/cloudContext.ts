import { createContext, useContext } from 'react';
import type { Cloud } from '../lib/planner';

/** The open plan's cloud, provided by App so every component can use the right words and rules. */
export const CloudContext = createContext<Cloud>('azure');

export const useCloud = () => useContext(CloudContext);
