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
                <div className="min-h-screen bg-background-light flex items-center justify-center p-8">
                    <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-10 text-center">
                        <div className="w-14 h-14 bg-red-50 rounded-xl flex items-center justify-center mx-auto mb-6">
                            <span className="material-symbols-outlined text-red-500 text-3xl">error</span>
                        </div>
                        <h1 className="text-lg font-bold text-slate-900 mb-2">Something went wrong</h1>
                        <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                            The simulation encountered an unexpected error. This is usually caused by invalid input parameters.
                        </p>
                        {this.state.error && (
                            <pre className="text-[11px] text-left bg-slate-50 border border-slate-200 rounded-lg p-4 mb-6 overflow-auto max-h-32 text-red-600">
                                {this.state.error.message}
                            </pre>
                        )}
                        <button
                            onClick={() => this.setState({ hasError: false, error: null })}
                            className="bg-emerald-900 text-white px-8 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-emerald-800 transition-all shadow-md cursor-pointer"
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
