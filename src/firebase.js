import { getApp, getApps, initializeApp } from 'firebase/app';
import { firebaseConfig } from './firebase-config.js';

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
