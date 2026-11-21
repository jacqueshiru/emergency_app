import React, { useState } from 'react';
import { Info, X } from 'lucide-react';

export const SystemLimitsBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <aside aria-label="System Notice" className="bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <Info className="w-4 h-4 text-amber-500 shrink-0" />
        <span>
          <strong className="text-zinc-200">System Notice:</strong> SEAS is a peer alert notification system, not a police or ambulance dispatch integration. SMS delivery depends on cellular carriers and continuous background tracking is not provided.
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 hover:text-zinc-200 rounded text-zinc-500 focus:outline-none"
        title="Dismiss notice"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </aside>
  );
};
