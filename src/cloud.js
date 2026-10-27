// This module and the npm SDK are loaded only when cloud sync is used.
import { getAuth, setPersistence, browserSessionPersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore/lite';
import { app } from './firebase.js';

export async function connectCloud(credentials) {
  const auth = getAuth(app);
  await setPersistence(auth, browserSessionPersistence);
  await auth.authStateReady();
  let user = auth.currentUser;
  if (credentials) {
    const action = credentials.createAccount ? createUserWithEmailAndPassword : signInWithEmailAndPassword;
    user = (await action(auth, credentials.email, credentials.password)).user;
  }
  if (!user) return null;
  const db = getFirestore(app);
  const reference = doc(db, 'users', user.uid, 'finance', 'budget');
  let revision;
  return {
    email: user.email,
    uid: user.uid,
    async load() {
      const snapshot = await getDoc(reference);
      revision = snapshot.exists() ? snapshot.data().revision : null;
      return snapshot.exists() ? snapshot.data().state : null;
    },
    async save(state) {
      const expected = revision;
      const nextRevision = (revision ?? 0) + 1;
      await runTransaction(db, async transaction => {
        const current = await transaction.get(reference);
        const remoteRevision = current.exists() ? current.data().revision : null;
        if (remoteRevision !== expected) throw new Error('Há alterações em outro dispositivo. Recarregue a página antes de salvar.');
        transaction.set(reference, {state, revision: nextRevision, updatedAt: serverTimestamp()});
      });
      revision = nextRevision;
    },
    async disconnect() { await signOut(auth); },
    onSignedOut(callback) { return onAuthStateChanged(auth, current => { if (!current) callback(); }); }
  };
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(getAuth(app), email);
}
