import { render, screen, fireEvent, act } from '../../../tests/helpers/render';
import PlaceAvatar from './PlaceAvatar';

const basePlaceNoImage = {
  id: 1,
  name: 'Eiffel Tower',
  image_url: null,
  google_place_id: null,
  osm_id: null,
  lat: 48.8584,
  lng: 2.2945,
};

const basePlaceWithImage = {
  ...basePlaceNoImage,
  image_url: 'https://example.com/eiffel.jpg',
};

describe('PlaceAvatar', () => {
  it('FE-COMP-AVATAR-001: renders an image when image_url is provided', () => {
    render(<PlaceAvatar place={basePlaceWithImage} />);
    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect((img as HTMLImageElement).src).toContain('eiffel.jpg');
  });

  it('FE-COMP-AVATAR-002: image has correct alt text equal to place.name', () => {
    render(<PlaceAvatar place={basePlaceWithImage} />);
    const img = screen.getByAltText('Eiffel Tower');
    expect(img).toBeTruthy();
  });

  it('FE-COMP-AVATAR-003: renders an icon (no img) when no image_url', () => {
    render(<PlaceAvatar place={basePlaceNoImage} />);
    expect(screen.queryByRole('img')).toBeNull();
    const { container } = render(<PlaceAvatar place={basePlaceNoImage} />);
    expect(container.querySelector('div')).toBeTruthy();
  });

  it('FE-COMP-AVATAR-004: uses category color as background color', () => {
    const { container } = render(
      <PlaceAvatar place={basePlaceWithImage} category={{ color: '#ff5733', icon: 'MapPin' }} />
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.backgroundColor).toBe('rgb(255, 87, 51)');
  });

  it('FE-COMP-AVATAR-005: uses default indigo color when no category provided', () => {
    const { container } = render(<PlaceAvatar place={basePlaceWithImage} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.backgroundColor).toBe('rgb(99, 102, 241)');
  });

  it('FE-COMP-AVATAR-006: falls back to icon when image fails to load', () => {
    render(<PlaceAvatar place={basePlaceWithImage} />);
    const img = screen.getByRole('img');
    act(() => {
      fireEvent.error(img);
    });
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('FE-COMP-AVATAR-007: respects the size prop for container dimensions', () => {
    const { container } = render(<PlaceAvatar place={basePlaceWithImage} size={64} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe('64px');
    expect(wrapper.style.height).toBe('64px');
  });

  it('FE-COMP-AVATAR-008: default size is 32px when size prop is omitted', () => {
    const { container } = render(<PlaceAvatar place={basePlaceWithImage} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.width).toBe('32px');
    expect(wrapper.style.height).toBe('32px');
  });

  it('FE-COMP-AVATAR-009: uses category icon (SVG) when no category provided', () => {
    const { container } = render(<PlaceAvatar place={basePlaceNoImage} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('FE-COMP-AVATAR-010: uses category-specific icon when category.icon is set', () => {
    const { container } = render(
      <PlaceAvatar place={basePlaceNoImage} category={{ icon: 'MapPin', color: '#ff0000' }} />
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('FE-COMP-AVATAR-011: tracks a changed image_url on re-render', () => {
    const { rerender } = render(<PlaceAvatar place={basePlaceNoImage} />);
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<PlaceAvatar place={basePlaceWithImage} />);
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('FE-COMP-AVATAR-012: clears the image when image_url is removed', () => {
    const { rerender } = render(<PlaceAvatar place={basePlaceWithImage} />);
    rerender(<PlaceAvatar place={basePlaceNoImage} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
