import React from 'react';

interface ErrorBoundaryProps {
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('Application error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-background-light dark:bg-background-dark flex items-center justify-center p-8 transition-colors">
                    <div className="max-w-md w-full bg-white dark:bg-slate-900 rounded-2xl shadow-lg border border-slate-200 dark:border-slate-800 p-10 text-center transition-colors">
                        <div className="w-14 h-14 bg-red-50 dark:bg-red-950/40 rounded-xl flex items-center justify-center mx-auto mb-6">
                            <span className="material-symbols-outlined text-red-500 text-3xl">error</span>
                        </div>
                        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2 transition-colors">Something went wrong</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-6 leading-relaxed transition-colors">
                            The simulation encountered an unexpected error. This is usually caused by invalid input parameters.
                        </p>
                        {this.state.error && (
                            <pre className="text-[11px] text-left bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-6 overflow-auto max-h-32 text-red-600 dark:text-red-400 transition-colors">
                                {this.state.error.message}
                            </pre>
                        )}
                        <button
                            onClick={() => this.setState({ hasError: false, error: null })}
                            className="bg-emerald-700 dark:bg-emerald-800 text-white px-8 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-emerald-600 dark:hover:bg-emerald-700 transition-all shadow-md cursor-pointer"
                        >
                            Try Again
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
