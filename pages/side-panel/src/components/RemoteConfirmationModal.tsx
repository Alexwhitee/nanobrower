import type { RemoteConfirmationRequest } from '@extension/shared';

interface RemoteConfirmationModalProps {
  request: RemoteConfirmationRequest | null;
  isDarkMode?: boolean;
  onRespond: (decision: 'approve' | 'reject' | 'stop') => void;
}

export default function RemoteConfirmationModal({
  request,
  isDarkMode = false,
  onRespond,
}: RemoteConfirmationModalProps) {
  if (!request) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={`w-full max-w-sm rounded-xl border p-4 shadow-xl ${isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
        <div className="text-base font-semibold">{request.title}</div>
        <div className={`mt-2 text-sm ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{request.message}</div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onRespond('approve')}
            className={`rounded-md px-3 py-2 text-sm font-medium ${isDarkMode ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}>
            {request.confirm_label}
          </button>
          <button
            type="button"
            onClick={() => onRespond('reject')}
            className={`rounded-md px-3 py-2 text-sm font-medium ${isDarkMode ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-800 hover:bg-slate-300'}`}>
            {request.reject_label}
          </button>
          <button
            type="button"
            onClick={() => onRespond('stop')}
            className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500">
            {request.stop_label}
          </button>
        </div>
      </div>
    </div>
  );
}
