import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { AuthService } from './core/auth/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation(), withComponentInputBinding()),
    // Restores any existing Cognito session before the router evaluates guards,
    // so a page refresh on a protected route doesn't briefly bounce to /login.
    provideAppInitializer(() => inject(AuthService).restoreSession()),
  ],
};
