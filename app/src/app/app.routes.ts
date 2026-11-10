import { Routes } from '@angular/router';
import { authGuard, adminGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'library' },
  {
    path: 'login',
    loadComponent: () => import('./auth-pages/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./settings/settings-page').then((m) => m.UserSettingsPage),
  },
  {
    path: 'library',
    canActivate: [authGuard],
    loadComponent: () => import('./media/browse-page/browse-page').then((m) => m.BrowsePage),
  },
  {
    path: 'library/:directoryId',
    canActivate: [authGuard],
    loadComponent: () => import('./media/directory-page/directory-page').then((m) => m.DirectoryPage),
  },
  {
    path: 'library/:directoryId/movie/:mediaItemId',
    canActivate: [authGuard],
    loadComponent: () => import('./media/movie-detail-page/movie-detail-page').then((m) => m.MovieDetailPage),
  },
  {
    path: 'library/:directoryId/show/:showTitle',
    canActivate: [authGuard],
    loadComponent: () => import('./media/show-page/show-page').then((m) => m.ShowPage),
  },
  {
    path: 'library/:directoryId/show/:showTitle/season/:season',
    canActivate: [authGuard],
    loadComponent: () => import('./media/show-page/show-page').then((m) => m.ShowPage),
  },
  {
    path: 'library/:directoryId/artist/:artistName',
    canActivate: [authGuard],
    loadComponent: () => import('./media/album-list-page/album-list-page').then((m) => m.AlbumListPage),
  },
  {
    path: 'library/:directoryId/artist/:artistName/album/:albumName',
    canActivate: [authGuard],
    loadComponent: () => import('./media/track-list-page/track-list-page').then((m) => m.TrackListPage),
  },
  {
    path: 'play/:mediaItemId',
    canActivate: [authGuard],
    loadComponent: () => import('./media/player-page/player-page').then((m) => m.PlayerPage),
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/admin-page').then((m) => m.AdminPage),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sections' },
      {
        path: 'sections',
        loadComponent: () => import('./admin/directories/directories-page').then((m) => m.DirectoriesPage),
      },
      {
        path: 'library',
        loadComponent: () => import('./admin/library/library-page').then((m) => m.LibraryPage),
      },
      {
        path: 'users',
        loadComponent: () => import('./admin/users/users-page').then((m) => m.UsersPage),
      },
      {
        path: 'site',
        loadComponent: () => import('./admin/settings/settings-page').then((m) => m.SettingsPage),
      },
      // Older links.
      { path: 'directories', redirectTo: 'sections' },
      { path: 'settings', redirectTo: 'site' },
    ],
  },
];
