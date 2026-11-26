import { database } from './storage.js';
import { legacyBranches } from './legacy-checkpoint.js';

// A legacy checkpoint is one large value. Inspect it outside the UI thread.
try {
  const tx = (await database()).transaction('items');
  tx.onabort = () => { self.postMessage({ error: tx.error?.message || '读取旧版进度失败' }); };
  legacyBranches(tx.objectStore('items'), branches => self.postMessage({ branches }));
} catch (error) { self.postMessage({ error: error.message }); }
