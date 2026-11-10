import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('uses the app title as the page title and hides the navigation when signed out', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(TestBed.inject(Title).getTitle()).toBe('My media');
    expect((fixture.nativeElement as HTMLElement).querySelector('app-nav')).toBeNull();
  });
});
