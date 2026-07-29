import React from 'react';

interface PhotoGalleryProps {
  photos: Array<{ src: string; caption: string }>;
}

// True positive: img without alt → triggers accessibility
export function PhotoGallery({ photos }: PhotoGalleryProps): JSX.Element {
  return (
    <div className="gallery">
      {photos.map((photo) => (
        <div key={photo.src}>
          <img src={photo.src} />
          <p>{photo.caption}</p>
        </div>
      ))}
    </div>
  );
}

// True positive: onClick on non-interactive div → triggers accessibility
interface ModalToggleProps {
  label: string;
}

export function ModalToggle({ label }: ModalToggleProps): JSX.Element {
  return (
    <div onClick={() => alert('opened')} className="modal-trigger">
      {label}
    </div>
  );
}

// Near-miss: img with alt + button onClick → does NOT trigger accessibility
interface AccessibleGalleryProps {
  photos: Array<{ src: string; caption: string; alt: string }>;
}

export function AccessibleGallery({ photos }: AccessibleGalleryProps): JSX.Element {
  return (
    <div className="gallery">
      {photos.map((photo) => (
        <div key={photo.src}>
          <img src={photo.src} alt={photo.alt} />
          <p>{photo.caption}</p>
        </div>
      ))}
      <button onClick={() => console.log('more')}>Load More</button>
    </div>
  );
}
